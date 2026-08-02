import type { Project } from "../../domain/project/project.js";
import type { AuditArtifactSet } from "../../domain/audit/audit-artifacts.js";
import { GitClient } from "../../infrastructure/git/git-client.js";
import {
  artifactHashes,
  type AuditArtifactRepository,
  type KnowledgeGeneration,
} from "../../infrastructure/persistence/audit-artifact-repository.js";
import type { ProjectFileRepository } from "../../infrastructure/persistence/project-file-repository.js";
import type { ProjectManager } from "../projects/project-service.js";
import { ProjectMetadataScanner } from "../projects/project-metadata-scanner.js";
import { StackDetector } from "../projects/stack-detector.js";
import type { Clock } from "../../shared/clock.js";
import { isoNow, systemClock } from "../../shared/clock.js";
import { OrchestratorError } from "../../shared/errors.js";
import {
  KnowledgeFreshnessService,
  type KnowledgeFreshnessAssessment,
} from "./knowledge-freshness-service.js";
import { SkillRegistry } from "../skills/skill-registry.js";

export type ProjectRefreshReport = {
  project: Project;
  knowledge?: KnowledgeGeneration;
  freshness?: KnowledgeFreshnessAssessment;
};

export interface ProjectRefresher {
  refresh(reference: string): Promise<ProjectRefreshReport>;
}

export class ProjectRefreshService implements ProjectRefresher {
  private readonly skillRegistry = new SkillRegistry();

  constructor(
    private readonly projects: ProjectManager,
    private readonly projectRepository: ProjectFileRepository,
    private readonly artifacts: AuditArtifactRepository,
    private readonly git = new GitClient(),
    private readonly stackDetector = new StackDetector(),
    private readonly metadataScanner = new ProjectMetadataScanner(),
    private readonly freshness = new KnowledgeFreshnessService(),
    private readonly clock: Clock = systemClock,
  ) {}

  async refresh(reference: string): Promise<ProjectRefreshReport> {
    const existing = await this.projects.inspect(reference);
    const before = {
      head: await this.git.resolveCommit(existing.gitRoot, "HEAD"),
      status: await this.git.statusPorcelain(existing.gitRoot),
    };
    const [gitMetadata, detected, metadata] = await Promise.all([
      this.git.inspectRepository(existing.gitRoot),
      this.stackDetector.detect(existing.gitRoot),
      this.metadataScanner.scan(existing.gitRoot),
    ]);
    if (
      (await this.git.resolveCommit(existing.gitRoot, "HEAD")) !== before.head ||
      (await this.git.statusPorcelain(existing.gitRoot)) !== before.status
    ) {
      throw new OrchestratorError("Repository changed while project metadata was refreshed", {
        code: "CONTEXT_INTEGRITY",
      });
    }
    const project: Project = {
      ...existing,
      repositoryPath: gitMetadata.repositoryPath,
      gitRoot: gitMetadata.gitRoot,
      currentHeadCommit: gitMetadata.headCommit,
      ...(gitMetadata.currentBranch === undefined
        ? { currentBranch: undefined }
        : { currentBranch: gitMetadata.currentBranch }),
      ...(gitMetadata.defaultBranch === undefined
        ? { defaultBranch: undefined }
        : { defaultBranch: gitMetadata.defaultBranch }),
      remotes: gitMetadata.remotes,
      detectedStack: detected.stack,
      verificationPolicy: detected.verificationPolicy,
      instructionFiles: metadata.instructionFiles,
      skillMetadata: metadata.skillMetadata,
      updatedAt: isoNow(this.clock),
    };
    await this.projectRepository.save(project);
    const generation = await this.artifacts.readOptional(project.id);
    if (generation === undefined) return { project };
    const changedFiles =
      generation.manifest.sourceCommit === gitMetadata.headCommit
        ? []
        : await this.git.changedFilesBetween(
            project.gitRoot,
            generation.manifest.sourceCommit,
            gitMetadata.headCommit,
          );
    const assessment = this.freshness.assess({
      generation,
      currentHeadCommit: gitMetadata.headCommit,
      instructionHashes: metadata.instructionFiles.map((item) => ({
        path: item.relativePath,
        sha256: item.sha256,
      })),
      selectedSkills: (await this.skillRegistry.select({ phase: "audit", project })).map(
        ({ name, source, sha256, instructionsSha256 }) => ({
          name,
          source,
          sha256,
          instructionsSha256,
        }),
      ),
      changedFiles,
    });
    const timestamp = isoNow(this.clock);
    const refreshedArtifacts = refreshArtifacts(generation.artifacts, assessment, timestamp);
    const refreshed = await this.artifacts.save(project.id, refreshedArtifacts, {
      ...generation.manifest,
      currentHeadCommit: gitMetadata.headCommit,
      artifactHashes: artifactHashes(refreshedArtifacts),
      stale: assessment.stale,
      staleReason: assessment.reason,
      validatedThroughCommit: assessment.validatedThroughCommit,
      updatedAt: timestamp,
    });
    return { project, knowledge: refreshed, freshness: assessment };
  }
}

function refreshArtifacts(
  artifacts: AuditArtifactSet,
  assessment: KnowledgeFreshnessAssessment,
  timestamp: string,
): AuditArtifactSet {
  return {
    repositoryMap: refreshArtifact(artifacts.repositoryMap, assessment, timestamp),
    architecture: refreshArtifact(artifacts.architecture, assessment, timestamp),
    businessRules: refreshArtifact(artifacts.businessRules, assessment, timestamp),
    verification: refreshArtifact(artifacts.verification, assessment, timestamp),
    risks: refreshArtifact(artifacts.risks, assessment, timestamp),
  };
}

function refreshArtifact<T extends AuditArtifactSet[keyof AuditArtifactSet]>(
  artifact: T,
  assessment: KnowledgeFreshnessAssessment,
  timestamp: string,
): T {
  return {
    ...artifact,
    stale: assessment.stale,
    staleReason: assessment.reason,
    validatedThroughCommit: assessment.validatedThroughCommit,
    revalidatedAt: assessment.validatedThroughCommit === undefined ? undefined : timestamp,
  };
}
