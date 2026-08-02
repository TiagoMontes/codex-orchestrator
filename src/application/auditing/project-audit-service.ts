import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type {
  AppConfig,
  ExecutionProfile,
  ReasoningPreset,
} from "../configuration/config-schema.js";
import type { ConfigService } from "../configuration/config-service.js";
import {
  auditAgentResultSchema,
  auditArtifactSetSchema,
  type AuditAgentResult,
  type AuditArtifactSet,
  type KnowledgeEvidenceReference,
  type KnowledgeManifest,
} from "../../domain/audit/audit-artifacts.js";
import type { NormalizedUsage } from "../../domain/usage/usage.js";
import type { CodexRuntime } from "../../infrastructure/codex/codex-runtime.js";
import { GitClient } from "../../infrastructure/git/git-client.js";
import {
  artifactHashes,
  type AuditArtifactRepository,
} from "../../infrastructure/persistence/audit-artifact-repository.js";
import { AtomicJsonStore } from "../../infrastructure/persistence/atomic-json-store.js";
import type { StatePaths } from "../../infrastructure/persistence/state-paths.js";
import { PromptLoader } from "../../prompts/prompt-loader.js";
import type { Clock } from "../../shared/clock.js";
import { isoNow, systemClock } from "../../shared/clock.js";
import { OrchestratorError } from "../../shared/errors.js";
import { sha256, stableJson } from "../../shared/hashing.js";
import { ContextSizer } from "../../orchestration/context/context-sizer.js";
import { ModelRouter } from "../../orchestration/routing/model-router.js";
import type { ProjectRefresher } from "./project-refresh-service.js";

export type ProjectAuditOverrides = {
  profile?: ExecutionProfile;
  model?: string;
  reasoning?: ReasoningPreset;
  maxTotalTokens?: number;
  maxAgentCalls?: number;
  parallelReaders?: number;
  allowNetwork?: boolean;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
};

export type ProjectAuditReport = {
  artifacts: AuditArtifactSet;
  manifest: KnowledgeManifest;
  threadId: string;
  usage: NormalizedUsage;
};

export interface ProjectAuditor {
  audit(reference: string, overrides?: ProjectAuditOverrides): Promise<ProjectAuditReport>;
}

export class ProjectAuditService implements ProjectAuditor {
  private readonly git = new GitClient();
  private readonly promptLoader = new PromptLoader();
  private readonly store = new AtomicJsonStore();

  constructor(
    private readonly configService: ConfigService,
    private readonly paths: StatePaths,
    private readonly refresher: ProjectRefresher,
    private readonly runtime: CodexRuntime,
    private readonly repository: AuditArtifactRepository,
    private readonly clock: Clock = systemClock,
  ) {}

  async audit(
    reference: string,
    overrides: ProjectAuditOverrides = {},
  ): Promise<ProjectAuditReport> {
    const config = await this.configService.load();
    const refreshed = await this.refresher.refresh(reference);
    const project = refreshed.project;
    const sourceCommit = await this.git.resolveCommit(project.gitRoot, "HEAD");
    const beforeStatus = await this.git.statusPorcelain(project.gitRoot);
    if (beforeStatus !== "") {
      throw new OrchestratorError(
        "Repository audit requires a clean checkout so every claim is commit-scoped",
        { code: "CONTEXT_INTEGRITY" },
      );
    }
    const allTrackedFiles = await this.git.listFilesAtCommit(project.gitRoot, sourceCommit);
    const trackedFiles = allTrackedFiles.slice(0, 5_000);
    const auditContext = {
      projectId: project.id,
      sourceCommit,
      stack: project.detectedStack,
      instructionFiles: project.instructionFiles.map((item) => ({
        path: item.relativePath,
        sha256: item.sha256,
      })),
      verificationPolicy: project.verificationPolicy,
      trackedFiles,
      inventoryTruncated: allTrackedFiles.length > trackedFiles.length,
    };
    const estimatedInputTokens = new ContextSizer(
      config.context.tokenEstimateSafetyMultiplier,
    ).estimate(auditContext).estimatedTokens;
    if (estimatedInputTokens > config.context.estimatedInputHardLimit) {
      throw new OrchestratorError("Audit inventory exceeds the hard context limit", {
        code: "BUDGET",
        resumable: true,
      });
    }
    const profile = overrides.profile ?? config.defaultProfile;
    const limits = effectiveLimits(config, profile, overrides);
    const projectedTokens = estimatedInputTokens + config.context.reservedOutputTokens;
    if (projectedTokens > limits.maxTotalTokens || limits.maxAgentCalls < 2) {
      throw new OrchestratorError("Audit call cannot be admitted by the selected budget", {
        code: "BUDGET",
        resumable: true,
      });
    }
    const decision = new ModelRouter(config).route({
      phase: "audit",
      profile,
      estimatedCallTokens: projectedTokens,
      remainingBudgetTokens: limits.maxTotalTokens,
      overrides: {
        ...(overrides.model === undefined ? {} : { model: overrides.model }),
        ...(overrides.reasoning === undefined ? {} : { reasoning: overrides.reasoning }),
      },
    });
    const auditRunId = randomUUID();
    const eventsPath = join(
      this.paths.knowledgeDirectory(project.id),
      "audit-runs",
      auditRunId,
      "events.jsonl",
    );
    const prompt = await this.promptLoader.render("audit.prompt.md", {
      SOURCE_COMMIT: sourceCommit,
      AUDIT_CONTEXT: stableJson(auditContext),
    });
    const runtimeResult = await this.runtime.runStructured({
      role: "audit-mapper",
      prompt,
      workingDirectory: project.gitRoot,
      model: decision.model,
      reasoningPreset: decision.reasoning,
      sandboxMode: "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: overrides.allowNetwork === true,
      outputSchema: toJsonSchema(auditAgentResultSchema),
      outputValidator: auditAgentResultSchema,
      timeoutMs: overrides.timeoutMs ?? config.runtime.defaultTimeoutSeconds * 1_000,
      eventsPath,
      ...(overrides.abortSignal === undefined ? {} : { abortSignal: overrides.abortSignal }),
    });
    if (runtimeResult.runtimeAttempts > limits.maxAgentCalls) {
      throw new OrchestratorError("Audit runtime exceeded its admitted call count", {
        code: "BUDGET",
      });
    }
    const output = auditAgentResultSchema.parse(runtimeResult.output);
    if (output.projectId !== project.id || output.sourceCommit !== sourceCommit) {
      throw new OrchestratorError("Audit output identity mismatch", {
        code: "CONTEXT_INTEGRITY",
      });
    }
    const evidence = await this.validateEvidence(
      output,
      project.gitRoot,
      sourceCommit,
      trackedFiles,
      config,
    );
    assertEvidenceLinks(output, evidence);
    if (
      (await this.git.resolveCommit(project.gitRoot, "HEAD")) !== sourceCommit ||
      (await this.git.statusPorcelain(project.gitRoot)) !== beforeStatus
    ) {
      throw new OrchestratorError("Repository changed during its read-only audit", {
        code: "CONTEXT_INTEGRITY",
      });
    }
    const generatedAt = isoNow(this.clock);
    const common = {
      schemaVersion: 1 as const,
      auditRunId,
      projectId: project.id,
      sourceCommit,
      generatedAt,
      modelDecision: decision,
      usage: runtimeResult.usage,
      evidenceReferences: evidence,
      stale: false,
    };
    const artifacts = auditArtifactSetSchema.parse({
      repositoryMap: {
        ...common,
        artifactType: "repository-map",
        payload: output.repositoryMap,
      },
      architecture: { ...common, artifactType: "architecture", payload: output.architecture },
      businessRules: {
        ...common,
        artifactType: "business-rules",
        payload: output.businessRules,
      },
      verification: {
        ...common,
        artifactType: "verification",
        payload: output.verification,
      },
      risks: { ...common, artifactType: "risks", payload: output.risks },
    });
    const manifest: KnowledgeManifest = {
      schemaVersion: 1,
      auditRunId,
      projectId: project.id,
      sourceCommit,
      currentHeadCommit: sourceCommit,
      instructionHashes: project.instructionFiles.map((item) => ({
        path: item.relativePath,
        sha256: item.sha256,
      })),
      artifactHashes: artifactHashes(artifacts),
      stale: false,
      updatedAt: generatedAt,
    };
    await this.repository.save(project.id, artifacts, manifest);
    await this.store.write(
      join(this.paths.knowledgeDirectory(project.id), "audit-runs", auditRunId, "run.json"),
      {
        schemaVersion: 1,
        auditRunId,
        projectId: project.id,
        sourceCommit,
        threadId: runtimeResult.threadId,
        modelDecision: decision,
        usage: runtimeResult.usage,
        runtimeAttempts: runtimeResult.runtimeAttempts,
        overrides: {
          ...(overrides.profile === undefined ? {} : { profile: overrides.profile }),
          ...(overrides.model === undefined ? {} : { model: overrides.model }),
          ...(overrides.reasoning === undefined ? {} : { reasoning: overrides.reasoning }),
          ...(overrides.maxTotalTokens === undefined
            ? {}
            : { maxTotalTokens: overrides.maxTotalTokens }),
          ...(overrides.maxAgentCalls === undefined
            ? {}
            : { maxAgentCalls: overrides.maxAgentCalls }),
          ...(overrides.parallelReaders === undefined
            ? {}
            : { parallelReaders: overrides.parallelReaders }),
          ...(overrides.allowNetwork === undefined ? {} : { allowNetwork: overrides.allowNetwork }),
          ...(overrides.timeoutMs === undefined ? {} : { timeoutMs: overrides.timeoutMs }),
        },
        completedAt: generatedAt,
      },
    );
    return { artifacts, manifest, threadId: runtimeResult.threadId, usage: runtimeResult.usage };
  }

  private async validateEvidence(
    output: AuditAgentResult,
    gitRoot: string,
    sourceCommit: string,
    trackedFiles: readonly string[],
    config: AppConfig,
  ): Promise<KnowledgeEvidenceReference[]> {
    if (output.evidenceReferences.length > config.context.maxEvidenceItems) {
      throw new OrchestratorError("Audit returned too many evidence items", { code: "BUDGET" });
    }
    const tracked = new Set(trackedFiles);
    const ids = new Set<string>();
    const validated: KnowledgeEvidenceReference[] = [];
    for (const item of output.evidenceReferences) {
      if (ids.has(item.id)) {
        throw new OrchestratorError(`Duplicate audit evidence ID: ${item.id}`, {
          code: "CONTEXT_INTEGRITY",
        });
      }
      ids.add(item.id);
      if (item.sourceCommit !== sourceCommit) {
        throw new OrchestratorError("Audit evidence source commit mismatch", {
          code: "CONTEXT_INTEGRITY",
        });
      }
      if (item.file === undefined) {
        if (item.status === "confirmed") {
          throw new OrchestratorError(
            `Confirmed audit evidence must cite a commit-scoped file: ${item.id}`,
            { code: "CONTEXT_INTEGRITY" },
          );
        }
        validated.push(item);
        continue;
      }
      if (!tracked.has(item.file)) {
        throw new OrchestratorError(`Audit evidence is not tracked at the source: ${item.file}`, {
          code: "CONTEXT_INTEGRITY",
        });
      }
      const contents = await this.git.showFileAtCommit(gitRoot, sourceCommit, item.file);
      const lines = contents.split(/\r?\n/u);
      const startLine = item.startLine ?? 1;
      const endLine = item.endLine ?? Math.min(Math.max(lines.length, 1), startLine + 19);
      if (startLine > lines.length || endLine > lines.length) {
        throw new OrchestratorError(`Audit evidence range is outside ${item.file}`, {
          code: "CONTEXT_INTEGRITY",
        });
      }
      validated.push({
        ...item,
        startLine,
        endLine,
        excerpt: lines
          .slice(startLine - 1, endLine)
          .join("\n")
          .slice(0, config.context.maxExcerptCharacters),
        sha256: sha256(contents),
      });
    }
    return validated;
  }
}

function assertEvidenceLinks(
  output: AuditAgentResult,
  evidence: readonly KnowledgeEvidenceReference[],
): void {
  const available = new Set(evidence.map((item) => item.id));
  const claims = [
    ...output.repositoryMap.modules,
    ...output.repositoryMap.entryPoints,
    ...output.architecture.components,
    ...output.architecture.relationships,
    ...output.businessRules.rules,
    ...output.verification.strategies,
    ...output.risks.risks,
  ];
  const referenced = claims.flatMap((claim) => claim.evidenceIds);
  const missing = [...new Set(referenced.filter((id) => !available.has(id)))];
  if (missing.length > 0) {
    throw new OrchestratorError(`Audit claims reference missing evidence: ${missing.join(", ")}`, {
      code: "CONTEXT_INTEGRITY",
    });
  }
  const statuses = new Map(evidence.map((item) => [item.id, item.status]));
  if (
    claims.some(
      (claim) =>
        claim.unknowns.length === 0 &&
        !claim.evidenceIds.some((id) => statuses.get(id) === "confirmed"),
    )
  ) {
    throw new OrchestratorError(
      "Audit claims require confirmed evidence or an explicit uncertainty",
      { code: "CONTEXT_INTEGRITY" },
    );
  }
}

function effectiveLimits(
  config: AppConfig,
  profile: ExecutionProfile,
  overrides: ProjectAuditOverrides,
): { maxTotalTokens: number; maxAgentCalls: number } {
  const configured = config.profiles[profile];
  return {
    maxTotalTokens: Math.min(
      configured.maxTotalTokens,
      overrides.maxTotalTokens ?? Number.POSITIVE_INFINITY,
    ),
    maxAgentCalls: Math.min(
      configured.maxAgentCalls,
      overrides.maxAgentCalls ?? Number.POSITIVE_INFINITY,
    ),
  };
}

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const converted = z.toJSONSchema(schema);
  if (converted === null || Array.isArray(converted) || typeof converted !== "object") {
    throw new OrchestratorError("Unable to create audit output schema", { code: "CONFIGURATION" });
  }
  return converted;
}
