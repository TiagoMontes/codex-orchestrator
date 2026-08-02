import { describe, expect, it } from "vitest";
import type { VerificationCommandResult } from "../../../src/domain/verification/verification.js";
import { failureSignature } from "../../../src/orchestration/engine/failure-signature.js";

const base: VerificationCommandResult = {
  name: "test",
  argv: ["node", "--test"],
  startedAt: "2026-08-02T12:00:00.000Z",
  completedAt: "2026-08-02T12:00:01.000Z",
  exitCode: 1,
  timedOut: false,
  status: "failed",
  logPath: "/tmp/one.log",
  logSha256: "a".repeat(64),
  excerpt: "",
  evidenceId: "V1",
};

describe("failureSignature", () => {
  it("normalizes volatile paths, ANSI, timestamps, PIDs, and durations", () => {
    const left = failureSignature({
      phase: "verification",
      sourceCommit: "1".repeat(40),
      diffHash: "2".repeat(64),
      worktreePath: "/tmp/worktree-a",
      commands: [
        {
          ...base,
          excerpt:
            "\u001b[31mnot ok 1 - public value\u001b[0m at /tmp/worktree-a 2026-08-02T12:00:00.000Z pid=12345 in 81ms",
        },
      ],
    });
    const right = failureSignature({
      phase: "verification",
      sourceCommit: "1".repeat(40),
      diffHash: "2".repeat(64),
      worktreePath: "/private/tmp/worktree-b",
      commands: [
        {
          ...base,
          excerpt:
            "not ok 1 - public value at /private/tmp/worktree-b 2026-09-03T14:20:10.000Z pid=98765 in 1.2s",
        },
      ],
    });

    expect(left).toBe(right);
    expect(
      failureSignature({
        phase: "verification",
        sourceCommit: "1".repeat(40),
        diffHash: "2".repeat(64),
        commands: [{ ...base, exitCode: 2, excerpt: "not ok 1 - public value" }],
      }),
    ).not.toBe(left);
  });
});
