import type {
  Project,
  VerificationCommand,
  VerificationPolicy,
} from "../../domain/project/project.js";
import { sha256, stableJson } from "../../shared/hashing.js";

export function approvedVerificationCommands(
  project: Pick<Project, "verificationPolicy">,
): VerificationCommand[] {
  const commands = [...project.verificationPolicy.focused, ...project.verificationPolicy.full];
  const seen = new Set<string>();
  return commands.filter((command) => {
    if (!command.approved) return false;
    const key = stableJson(command.argv);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function verificationPolicyHash(
  projectOrPolicy: Pick<Project, "verificationPolicy"> | VerificationPolicy,
): string {
  const project =
    "verificationPolicy" in projectOrPolicy
      ? projectOrPolicy
      : { verificationPolicy: projectOrPolicy };
  return sha256(
    stableJson(
      approvedVerificationCommands(project).map(({ name, argv, timeoutSeconds }) => ({
        name,
        argv,
        timeoutSeconds,
      })),
    ),
  );
}
