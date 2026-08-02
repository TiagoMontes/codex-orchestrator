import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import {
  architectureArtifactSchema,
  auditArtifactSetSchema,
  auditVerificationArtifactSchema,
  businessRulesArtifactSchema,
  knowledgeManifestSchema,
  repositoryMapArtifactSchema,
  risksArtifactSchema,
  type AuditArtifactSet,
  type KnowledgeManifest,
} from "../../domain/audit/audit-artifacts.js";
import { OrchestratorError } from "../../shared/errors.js";
import { hashJson } from "../../shared/hashing.js";
import { AtomicJsonStore } from "./atomic-json-store.js";
import { FileLockManager } from "./file-lock.js";
import type { StatePaths } from "./state-paths.js";

export type KnowledgeGeneration = {
  artifacts: AuditArtifactSet;
  manifest: KnowledgeManifest;
};

export class AuditArtifactRepository {
  private readonly locks: FileLockManager;

  constructor(
    private readonly paths: StatePaths,
    private readonly store = new AtomicJsonStore(),
  ) {
    this.locks = new FileLockManager(paths.locksDirectory);
  }

  async save(
    projectId: string,
    artifactsInput: AuditArtifactSet,
    manifestInput: KnowledgeManifest,
  ): Promise<KnowledgeGeneration> {
    const artifacts = auditArtifactSetSchema.parse(artifactsInput);
    const manifest = knowledgeManifestSchema.parse(manifestInput);
    this.assertGeneration(projectId, artifacts, manifest);
    const lock = await this.locks.acquire(`knowledge:${projectId}`);
    try {
      const directory = this.paths.knowledgeDirectory(projectId);
      await this.store.write(
        join(directory, "repository-map.json"),
        repositoryMapArtifactSchema.parse(artifacts.repositoryMap),
      );
      await this.store.write(
        join(directory, "architecture.json"),
        architectureArtifactSchema.parse(artifacts.architecture),
      );
      await this.store.write(
        join(directory, "business-rules.json"),
        businessRulesArtifactSchema.parse(artifacts.businessRules),
      );
      await this.store.write(
        join(directory, "verification.json"),
        auditVerificationArtifactSchema.parse(artifacts.verification),
      );
      await this.store.write(
        join(directory, "risks.json"),
        risksArtifactSchema.parse(artifacts.risks),
      );
      await this.store.write(join(directory, "manifest.json"), manifest);
      return { artifacts, manifest };
    } finally {
      await lock.release();
    }
  }

  async read(projectId: string): Promise<KnowledgeGeneration> {
    const directory = this.paths.knowledgeDirectory(projectId);
    const [repositoryMap, architecture, businessRules, verification, risks, manifest] =
      await Promise.all([
        this.store.read(join(directory, "repository-map.json"), repositoryMapArtifactSchema),
        this.store.read(join(directory, "architecture.json"), architectureArtifactSchema),
        this.store.read(join(directory, "business-rules.json"), businessRulesArtifactSchema),
        this.store.read(join(directory, "verification.json"), auditVerificationArtifactSchema),
        this.store.read(join(directory, "risks.json"), risksArtifactSchema),
        this.store.read(join(directory, "manifest.json"), knowledgeManifestSchema),
      ]);
    const artifacts = auditArtifactSetSchema.parse({
      repositoryMap,
      architecture,
      businessRules,
      verification,
      risks,
    });
    this.assertGeneration(projectId, artifacts, manifest);
    return { artifacts, manifest };
  }

  async readOptional(projectId: string): Promise<KnowledgeGeneration | undefined> {
    if (!(await exists(join(this.paths.knowledgeDirectory(projectId), "manifest.json")))) {
      return undefined;
    }
    return this.read(projectId);
  }

  private assertGeneration(
    projectId: string,
    artifacts: AuditArtifactSet,
    manifest: KnowledgeManifest,
  ): void {
    const items = Object.values(artifacts);
    if (
      manifest.projectId !== projectId ||
      items.some(
        (artifact) =>
          artifact.projectId !== projectId ||
          artifact.auditRunId !== manifest.auditRunId ||
          artifact.sourceCommit !== manifest.sourceCommit ||
          artifact.stale !== manifest.stale,
      )
    ) {
      throw new OrchestratorError("Knowledge artifact generation identity mismatch", {
        code: "CONTEXT_INTEGRITY",
      });
    }
    const hashes = artifactHashes(artifacts);
    if (
      Object.entries(hashes).some(
        ([key, value]) => manifest.artifactHashes[key as keyof typeof hashes] !== value,
      )
    ) {
      throw new OrchestratorError("Knowledge artifact generation hash mismatch", {
        code: "CONTEXT_INTEGRITY",
      });
    }
  }
}

export function artifactHashes(artifacts: AuditArtifactSet): KnowledgeManifest["artifactHashes"] {
  return {
    repositoryMap: hashJson(artifacts.repositoryMap),
    architecture: hashJson(artifacts.architecture),
    businessRules: hashJson(artifacts.businessRules),
    verification: hashJson(artifacts.verification),
    risks: hashJson(artifacts.risks),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
