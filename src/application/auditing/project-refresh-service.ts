import type { Project } from "../../domain/project/project.js";
import type { AuditArtifactSet } from "../../domain/audit/audit-artifacts.js";
import type { GitClient } from "../../infrastructure/git/git-client.js";
import { GitClientFactory } from "../../infrastructure/git/git-client-factory.js";
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
import { hashJson } from "../../shared/hashing.js";
import {
  KnowledgeFreshnessService,
  type KnowledgeFreshnessAssessment,
} from "./knowledge-freshness-service.js";
import { SkillRegistry } from "../skills/skill-registry.js";
import type { StatePaths } from "../../infrastructure/persistence/state-paths.js";
import { FileLockManager } from "../../infrastructure/persistence/file-lock.js";

export type ProjectRefreshReport = {
  project: Project;
  knowledge?: KnowledgeGeneration;
  freshness?: KnowledgeFreshnessAssessment;
};

export interface ProjectRefresher {
  refresh(
    reference: string,
    options?: { skipOperationLock?: boolean },
  ): Promise<ProjectRefreshReport>;
}

export class ProjectRefreshService implements ProjectRefresher {
  private readonly skillRegistry = new SkillRegistry();
  private readonly operationLocks: FileLockManager;
  private readonly gitClients: GitClientFactory;

  constructor(
    private readonly projects: ProjectManager,
    private readonly projectRepository: ProjectFileRepository,
    private readonly artifacts: AuditArtifactRepository,
    private readonly gitOverride: GitClient | undefined = undefined,
    private readonly stackDetector = new StackDetector(),
    private readonly metadataScanner = new ProjectMetadataScanner(),
    private readonly freshness = new KnowledgeFreshnessService(),
    private readonly clock: Clock = systemClock,
    paths?: StatePaths,
  ) {
    const statePaths = paths ?? projectRepository.paths;
    this.operationLocks = new FileLockManager(statePaths.locksDirectory);
    this.gitClients = new GitClientFactory(statePaths);
  }

  async refresh(
    reference: string,
    options: { skipOperationLock?: boolean } = {},
  ): Promise<ProjectRefreshReport> {
    if (options.skipOperationLock === true) return this.refreshUnlocked(reference);
    const initial = await this.projects.inspect(reference);
    const lock = await this.operationLocks.acquire(`project-operation:${initial.id}`);
    try {
      return await this.refreshUnlocked(initial.id);
    } finally {
      await lock.release();
    }
  }

  private async refreshUnlocked(reference: string): Promise<ProjectRefreshReport> {
    const existing = await this.projects.inspect(reference);
    const git =
      this.gitOverride ?? this.gitClients.project(existing.id, { phase: "project-refresh" });
    const before = {
      head: await git.resolveCommit(existing.gitRoot, "HEAD"),
      status: await git.statusPorcelain(existing.gitRoot),
    };
    const [gitMetadata, detected, metadata] = await Promise.all([
      git.inspectRepository(existing.gitRoot),
      this.stackDetector.detect(existing.gitRoot),
      this.metadataScanner.scan(existing.gitRoot),
    ]);
    if (
      (await git.resolveCommit(existing.gitRoot, "HEAD")) !== before.head ||
      (await git.statusPorcelain(existing.gitRoot)) !== before.status
    ) {
      throw new OrchestratorError("Repository changed while project metadata was refreshed", {
        code: "CONTEXT_INTEGRITY",
      });
    }
    const detectedProject: Project = {
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
    await this.projectRepository.save(detectedProject);
    const project = await this.projects.inspect(detectedProject.id);
    const generation = await this.artifacts.readOptional(project.id);
    if (generation === undefined) return { project };
    const changedFiles =
      generation.manifest.sourceCommit === gitMetadata.headCommit
        ? []
        : await git.changedFilesBetween(
            project.gitRoot,
            generation.manifest.sourceCommit,
            gitMetadata.headCommit,
          );
    const assessment = this.freshness.assess({
      generation,
      currentHeadCommit: gitMetadata.headCommit,
      verificationPolicyHash: hashJson(project.verificationPolicy),
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
