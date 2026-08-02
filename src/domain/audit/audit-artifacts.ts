import { z } from "zod";
import { modelDecisionSchema } from "../execution/model-decision.js";
import { normalizedUsageSchema } from "../usage/usage.js";

const HASH = /^[a-f0-9]{64}$/u;

export const knowledgeEvidenceReferenceSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["file", "symbol", "git", "command", "test"]),
    status: z.enum(["confirmed", "unverified"]),
    statement: z.string().min(1),
    sourceCommit: z.string().min(1),
    file: z.string().min(1).optional(),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    symbol: z.string().min(1).optional(),
    excerpt: z.string().optional(),
    sha256: z.string().regex(HASH).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.startLine === undefined ||
      value.endLine === undefined ||
      value.endLine >= value.startLine,
    { message: "Evidence endLine must not precede startLine", path: ["endLine"] },
  );

const evidencedClaimShape = {
  evidenceIds: z.array(z.string().min(1)),
  unknowns: z.array(z.string().min(1)),
};

function hasSupport(value: { evidenceIds: string[]; unknowns: string[] }): boolean {
  return value.evidenceIds.length > 0 || value.unknowns.length > 0;
}

const repositoryItemSchema = z
  .object({
    id: z.string().min(1),
    path: z.string().min(1),
    description: z.string().min(1),
    ...evidencedClaimShape,
  })
  .strict()
  .refine(hasSupport, { message: "Repository-map claims require evidence or uncertainty" });

export const repositoryMapPayloadSchema = z
  .object({
    summary: z.string().min(1),
    modules: z.array(repositoryItemSchema),
    entryPoints: z.array(repositoryItemSchema),
    unknowns: z.array(z.string().min(1)),
  })
  .strict();

const architectureComponentSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    responsibility: z.string().min(1),
    paths: z.array(z.string().min(1)),
    ...evidencedClaimShape,
  })
  .strict()
  .refine(hasSupport, { message: "Architecture claims require evidence or uncertainty" });

const architectureRelationshipSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
    relationship: z.string().min(1),
    ...evidencedClaimShape,
  })
  .strict()
  .refine(hasSupport, { message: "Architecture relationships require evidence or uncertainty" });

export const architecturePayloadSchema = z
  .object({
    summary: z.string().min(1),
    components: z.array(architectureComponentSchema),
    relationships: z.array(architectureRelationshipSchema),
    unknowns: z.array(z.string().min(1)),
  })
  .strict();

export const businessRuleSchema = z
  .object({
    id: z.string().min(1),
    domain: z.string().min(1),
    statement: z.string().min(1),
    confidence: z.enum(["high", "medium", "low"]),
    evidenceIds: z.array(z.string().min(1)),
    relatedRoutes: z.array(z.string()),
    relatedSymbols: z.array(z.string()),
    exceptions: z.array(z.string()),
    unknowns: z.array(z.string()),
  })
  .strict()
  .refine(hasSupport, { message: "Business rules require evidence or uncertainty" });

export const businessRulesPayloadSchema = z
  .object({
    rules: z.array(businessRuleSchema),
    unknowns: z.array(z.string().min(1)),
  })
  .strict();

const verificationStrategySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    kind: z.enum(["test", "lint", "typecheck", "build", "other"]),
    command: z.string().min(1).optional(),
    statement: z.string().min(1),
    ...evidencedClaimShape,
  })
  .strict()
  .refine(hasSupport, { message: "Verification claims require evidence or uncertainty" });

export const auditVerificationPayloadSchema = z
  .object({
    summary: z.string().min(1),
    strategies: z.array(verificationStrategySchema),
    unknowns: z.array(z.string().min(1)),
  })
  .strict();

const auditRiskSchema = z
  .object({
    id: z.string().min(1),
    statement: z.string().min(1),
    severity: z.enum(["critical", "high", "medium", "low"]),
    affectedPaths: z.array(z.string()),
    ...evidencedClaimShape,
  })
  .strict()
  .refine(hasSupport, { message: "Risk claims require evidence or uncertainty" });

export const risksPayloadSchema = z
  .object({
    summary: z.string().min(1),
    risks: z.array(auditRiskSchema),
    unknowns: z.array(z.string().min(1)),
  })
  .strict();

export const auditAgentResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId: z.string().min(1),
    sourceCommit: z.string().min(1),
    repositoryMap: repositoryMapPayloadSchema,
    architecture: architecturePayloadSchema,
    businessRules: businessRulesPayloadSchema,
    verification: auditVerificationPayloadSchema,
    risks: risksPayloadSchema,
    evidenceReferences: z.array(knowledgeEvidenceReferenceSchema).max(100),
  })
  .strict();

const envelopeShape = {
  schemaVersion: z.literal(1),
  auditRunId: z.string().uuid(),
  projectId: z.string().min(1),
  sourceCommit: z.string().min(1),
  generatedAt: z.string().datetime(),
  modelDecision: modelDecisionSchema,
  usage: normalizedUsageSchema,
  evidenceReferences: z.array(knowledgeEvidenceReferenceSchema),
  stale: z.boolean(),
  staleReason: z.string().min(1).optional(),
  validatedThroughCommit: z.string().min(1).optional(),
  revalidatedAt: z.string().datetime().optional(),
};

export const repositoryMapArtifactSchema = z
  .object({
    ...envelopeShape,
    artifactType: z.literal("repository-map"),
    payload: repositoryMapPayloadSchema,
  })
  .strict();

export const architectureArtifactSchema = z
  .object({
    ...envelopeShape,
    artifactType: z.literal("architecture"),
    payload: architecturePayloadSchema,
  })
  .strict();

export const businessRulesArtifactSchema = z
  .object({
    ...envelopeShape,
    artifactType: z.literal("business-rules"),
    payload: businessRulesPayloadSchema,
  })
  .strict();

export const auditVerificationArtifactSchema = z
  .object({
    ...envelopeShape,
    artifactType: z.literal("verification"),
    payload: auditVerificationPayloadSchema,
  })
  .strict();

export const risksArtifactSchema = z
  .object({
    ...envelopeShape,
    artifactType: z.literal("risks"),
    payload: risksPayloadSchema,
  })
  .strict();

export const auditArtifactSetSchema = z
  .object({
    repositoryMap: repositoryMapArtifactSchema,
    architecture: architectureArtifactSchema,
    businessRules: businessRulesArtifactSchema,
    verification: auditVerificationArtifactSchema,
    risks: risksArtifactSchema,
  })
  .strict();

export const knowledgeManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    auditRunId: z.string().uuid(),
    projectId: z.string().min(1),
    sourceCommit: z.string().min(1),
    currentHeadCommit: z.string().min(1),
    instructionHashes: z.array(
      z.object({ path: z.string().min(1), sha256: z.string().regex(HASH) }).strict(),
    ),
    selectedSkills: z
      .array(
        z
          .object({
            name: z.string().min(1),
            source: z.enum(["bundled", "project", "user"]),
            sha256: z.string().regex(HASH),
            instructionsSha256: z.string().regex(HASH),
          })
          .strict(),
      )
      .default([]),
    artifactHashes: z
      .object({
        repositoryMap: z.string().regex(HASH),
        architecture: z.string().regex(HASH),
        businessRules: z.string().regex(HASH),
        verification: z.string().regex(HASH),
        risks: z.string().regex(HASH),
      })
      .strict(),
    stale: z.boolean(),
    staleReason: z.string().min(1).optional(),
    validatedThroughCommit: z.string().min(1).optional(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type KnowledgeEvidenceReference = z.infer<typeof knowledgeEvidenceReferenceSchema>;
export type AuditAgentResult = z.infer<typeof auditAgentResultSchema>;
export type AuditArtifactSet = z.infer<typeof auditArtifactSetSchema>;
export type KnowledgeManifest = z.infer<typeof knowledgeManifestSchema>;
