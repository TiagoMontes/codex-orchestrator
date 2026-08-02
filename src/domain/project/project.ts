import { z } from "zod";

export const verificationCommandSchema = z
  .object({
    name: z.string().min(1).max(200),
    argv: z.array(z.string().min(1).max(4_096)).min(1).max(64),
    timeoutSeconds: z.number().int().positive().max(3_600),
    source: z.string().min(1).max(500),
    approved: z.boolean(),
  })
  .strict();

export const verificationPolicySchema = z
  .object({
    focused: z.array(verificationCommandSchema),
    full: z.array(verificationCommandSchema),
    candidates: z.array(verificationCommandSchema),
  })
  .strict();

const projectVerificationCommandConfigSchema = z
  .object({
    name: z.string().min(1).max(200),
    command: z.array(z.string().min(1).max(4_096)).min(1).max(64).optional(),
    argv: z.array(z.string().min(1).max(4_096)).min(1).max(64).optional(),
    timeoutSeconds: z.number().int().positive().max(3_600),
    source: z.string().min(1).max(500).default("project-config.yaml"),
    approved: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.command === undefined) === (value.argv === undefined)) {
      context.addIssue({
        code: "custom",
        message: "Specify exactly one of command or argv",
        path: ["command"],
      });
    }
  })
  .transform(({ command, argv, ...value }) => ({
    ...value,
    argv: command ?? argv ?? [],
  }));

export const projectConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId: z.string().min(1),
    verification: z
      .object({
        focused: z.array(projectVerificationCommandConfigSchema),
        full: z.array(projectVerificationCommandConfigSchema),
        candidates: z.array(projectVerificationCommandConfigSchema),
      })
      .strict(),
  })
  .strict();

export const detectedStackSchema = z
  .object({
    languages: z.array(z.string()),
    packageManagers: z.array(z.string()),
    frameworks: z.array(z.string()),
    manifests: z.array(z.string()),
  })
  .strict();

export const instructionFileReferenceSchema = z
  .object({
    path: z.string().min(1),
    relativePath: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export const skillMetadataSchema = z
  .object({
    name: z.string().min(1),
    description: z.string(),
    path: z.string().min(1),
    relativePath: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    source: z.enum(["bundled", "project", "user"]),
    tags: z.array(z.string()),
  })
  .strict();

export const projectSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    name: z.string().min(1),
    repositoryPath: z.string().min(1),
    gitRoot: z.string().min(1),
    baseRef: z.string().min(1),
    registeredHeadCommit: z.string().regex(/^[a-f0-9]{40,64}$/u),
    currentHeadCommit: z
      .string()
      .regex(/^[a-f0-9]{40,64}$/u)
      .optional(),
    currentBranch: z.string().min(1).optional(),
    defaultBranch: z.string().min(1).optional(),
    remotes: z.array(
      z
        .object({
          name: z.string().min(1),
          urlRedacted: z.string(),
        })
        .strict(),
    ),
    detectedStack: detectedStackSchema,
    instructionFiles: z.array(instructionFileReferenceSchema),
    skillMetadata: z.array(skillMetadataSchema),
    verificationPolicy: verificationPolicySchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const projectIndexSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectIds: z.array(z.string()),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type Project = z.infer<typeof projectSchema>;
export type ProjectIndex = z.infer<typeof projectIndexSchema>;
export type DetectedStack = z.infer<typeof detectedStackSchema>;
export type InstructionFileReference = z.infer<typeof instructionFileReferenceSchema>;
export type SkillMetadata = z.infer<typeof skillMetadataSchema>;
export type VerificationCommand = z.infer<typeof verificationCommandSchema>;
export type VerificationPolicy = z.infer<typeof verificationPolicySchema>;
export type ProjectConfig = z.output<typeof projectConfigSchema>;
