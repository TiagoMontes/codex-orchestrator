import type { VerificationCommandResult } from "../../domain/verification/verification.js";
import { hashJson } from "../../shared/hashing.js";

const ANSI_ESCAPE_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "gu");

export type FailureSignatureInput = {
  phase: "verification" | "review";
  sourceCommit: string;
  diffHash: string;
  commands: readonly VerificationCommandResult[];
  worktreePath?: string;
};

export function failureSignature(input: FailureSignatureInput): string {
  const failed = input.commands
    .filter((command) => command.status !== "passed")
    .map((command) => {
      const errorTail = normalizeFailureText(command.excerpt, input.worktreePath);
      return {
        name: command.name,
        argv: command.argv,
        exitCode: command.exitCode,
        signal: command.signal ?? null,
        timedOut: command.timedOut,
        failedTests: extractFailedTests(errorTail),
        errorTail,
      };
    });
  return hashJson({
    phase: input.phase,
    sourceCommit: input.sourceCommit,
    diffHash: input.diffHash,
    failed,
  });
}

export function normalizeFailureText(value: string, worktreePath?: string): string {
  let normalized = value
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/gu, "<timestamp>")
    .replace(/\bduration_ms(?:\s*:\s*|\s+)\d+(?:\.\d+)?\b/giu, "duration_ms: <duration>")
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|milliseconds?|s|seconds?)\b/giu, "<duration>")
    .replace(/\b(?:pid[=: ]*)?\d{4,}\b/giu, "<number>");
  if (worktreePath !== undefined && worktreePath !== "") {
    normalized = normalized.split(worktreePath).join("<worktree>");
  }
  return normalized.replace(/\s+/gu, " ").trim().slice(-2_000);
}

function extractFailedTests(value: string): string[] {
  const names = new Set<string>();
  for (const line of value.replace(ANSI_ESCAPE_PATTERN, "").split(/\r?\n/u)) {
    const match = /^(?:not ok\s+\d+\s+-|FAIL\s+|[×✗]\s+)(.+)$/iu.exec(line.trim());
    if (match?.[1] !== undefined) names.add(match[1].trim());
  }
  return [...names].sort();
}
