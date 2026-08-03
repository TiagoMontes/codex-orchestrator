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
    focused: z.array(verificationCommandSchema).max(64),
    full: z.array(verificationCommandSchema).max(64),
    candidates: z.array(verificationCommandSchema).max(64),
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
    const argv = value.command ?? value.argv ?? [];
    if (argv.some((argument) => /[\0\r\n]/u.test(argument))) {
      context.addIssue({
        code: "custom",
        message: "Command arguments cannot contain NUL or line breaks",
        path: ["command"],
      });
    }
    if (containsSensitiveCommandArgument(argv)) {
      context.addIssue({
        code: "custom",
        message:
          "Command arguments cannot contain credential-like values; use named environment configuration",
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
    environment: z
      .object({
        allowlist: z
          .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u))
          .max(128)
          .default([]),
        secretExceptions: z
          .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u))
          .max(32)
          .default([]),
      })
      .strict()
      .default({ allowlist: [], secretExceptions: [] })
      .superRefine((value, context) => {
        if (new Set(value.allowlist).size !== value.allowlist.length) {
          context.addIssue({
            code: "custom",
            message: "Environment allowlist names must be unique",
          });
        }
        if (new Set(value.secretExceptions).size !== value.secretExceptions.length) {
          context.addIssue({ code: "custom", message: "Secret exception names must be unique" });
        }
        for (const name of value.secretExceptions) {
          if (!value.allowlist.includes(name)) {
            context.addIssue({
              code: "custom",
              message: `Secret exception ${name} must also be allowlisted`,
              path: ["secretExceptions"],
            });
          }
        }
      }),
    verification: z
      .object({
        focused: z.array(projectVerificationCommandConfigSchema).max(64),
        full: z.array(projectVerificationCommandConfigSchema).max(64),
        candidates: z.array(projectVerificationCommandConfigSchema).max(64),
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
    environmentPolicy: z
      .object({
        allowlist: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)).max(128),
        secretExceptions: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)).max(32),
      })
      .strict()
      .default({ allowlist: [], secretExceptions: [] }),
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

function containsSensitiveCommandArgument(argv: readonly string[]): boolean {
  const sensitiveFlag =
    /^(?:--?|\/)(?:(?:[a-z0-9]+[-_])*(?:cookie|credential|key|password|passwd|secret|token)|(?:api|auth|access|client|private|refresh)(?:key|token))(?:[=:].*)?$/iu;
  const credentialedUrl = /^[a-z][a-z0-9+.-]*:\/\/[^/@\s:]+:[^/@\s]+@/iu;
  const authorizationValue = /^(?:basic|bearer)\s+\S+/iu;
  const authorizationHeader = /^authorization\s*:\s*(?:basic|bearer)\s+\S+/iu;
  const secretAssignment =
    /(?:^|[?&/:])(?:[a-z0-9_-]*(?:token|key|secret|password|passwd|cookie|credential|auth)[a-z0-9_-]*)=.+/iu;
  for (const [index, argument] of argv.entries()) {
    if (
      sensitiveFlag.test(argument) ||
      credentialedUrl.test(argument) ||
      authorizationValue.test(argument) ||
      authorizationHeader.test(argument) ||
      secretAssignment.test(argument)
    ) {
      return true;
    }
    const following = argv[index + 1] ?? "";
    const inlineValue = argument.includes("=") ? argument.slice(argument.indexOf("=") + 1) : "";
    if (
      /^(?:-u|--user|--proxy-user|--ftp-account)(?:=|$)/iu.test(argument) &&
      /\S+:\S+/u.test(inlineValue || following)
    ) {
      return true;
    }
    if (
      /^(?:-H|--header)(?:=|$)/u.test(argument) &&
      /^(?:authorization|proxy-authorization|x-api-key|x-auth-token|cookie|set-cookie)\s*:/iu.test(
        inlineValue || following,
      )
    ) {
      return true;
    }
    if (
      /(?:^|=)(?:authorization|proxy-authorization|x-api-key|x-auth-token)\s*:/iu.test(argument)
    ) {
      return true;
    }
  }
  return false;
}
