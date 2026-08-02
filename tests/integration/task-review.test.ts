import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskReviewService } from "../../src/application/tasks/task-review-service.js";
import type {
  CodexRunRequest,
  CodexRunResult,
  CodexRuntime,
} from "../../src/infrastructure/codex/codex-runtime.js";
import { DiffService } from "../../src/infrastructure/git/diff-service.js";
import { DecisionFileRepository } from "../../src/infrastructure/persistence/decision-file-repository.js";
import { EvidenceFileRepository } from "../../src/infrastructure/persistence/evidence-file-repository.js";
import { ExecutionFileRepository } from "../../src/infrastructure/persistence/execution-file-repository.js";
import { ReviewFileRepository } from "../../src/infrastructure/persistence/review-file-repository.js";
import { UsageFileRepository } from "../../src/infrastructure/persistence/usage-file-repository.js";
import { VerificationFileRepository } from "../../src/infrastructure/persistence/verification-file-repository.js";
import { createGitFixture, gitOutput } from "../helpers/git-fixture.js";
import { createImplementedTaskFixture } from "../helpers/implemented-task-fixture.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true })),
  );
});

describe("task review", () => {
  it("runs a fresh reviewer after a focused correction and completes only the new diff", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "cxo-review-fixture-"));
    const stateHome = await mkdtemp(join(tmpdir(), "cxo-review-state-"));
    temporaryDirectories.push(fixture, stateHome);
    await createGitFixture(fixture);
    const seeded = await createImplementedTaskFixture(fixture, stateHome);
    const beforeHead = await gitOutput(fixture, ["rev-parse", "HEAD"]);
    const beforeStatus = await gitOutput(fixture, ["status", "--porcelain=v1"]);
    const roles: string[] = [];
    const sandboxes: string[] = [];
    const threadIds: string[] = [];
    let reviewCalls = 0;
    const runtime: CodexRuntime = {
      runStructured: async (request) => {
        roles.push(request.role);
        sandboxes.push(request.sandboxMode);
        expect(request.resumeThreadId).toBeUndefined();
        if (request.role === "corrector") {
          await writeFile(
            join(request.workingDirectory, "index.js"),
            "// Reviewed invariant: keep publicValue exported.\nexport const publicValue = 2;\n",
            "utf8",
          );
          const threadId = "review-correction-thread";
          threadIds.push(threadId);
          return agentResponse(
            request,
            {
              schemaVersion: 1,
              taskId: seeded.task.id,
              status: "changed",
              summary: "Documented the protected export invariant",
              advisoryChangedFiles: ["index.js"],
              testsAddedOrUpdated: [],
              unresolvedRisks: [],
              completedAt: "2026-08-02T12:05:00.000Z",
            },
            threadId,
          );
        }
        reviewCalls += 1;
        const diff = await new DiffService(seeded.paths).read(seeded.project.id, seeded.task.id);
        const verification = await new VerificationFileRepository(seeded.paths).read(
          seeded.project.id,
          seeded.task.id,
        );
        expect(request.prompt).toContain(diff.diffHash);
        const evidenceId = verification.commands[0]?.evidenceId ?? "E1";
        const output =
          reviewCalls === 1
            ? {
                schemaVersion: 1,
                taskId: seeded.task.id,
                sourceCommit: seeded.sourceCommit,
                reviewedDiffHash: diff.diffHash,
                verdict: "changes-requested",
                findings: [
                  {
                    id: "F1",
                    severity: "medium",
                    category: "contract",
                    title: "Protected export invariant is not documented",
                    explanation: "The changed export should retain an explicit invariant note.",
                    file: "index.js",
                    startLine: 1,
                    endLine: 1,
                    evidenceIds: ["E1"],
                    recommendation: "Add a concise invariant comment without changing behavior.",
                  },
                ],
                acceptanceCriteriaAssessment: seeded.task.acceptanceCriteria.map(
                  (criterion, index) => ({
                    criterionId: criterion.id,
                    status: index === 0 ? "not-met" : "met",
                    evidenceIds: [evidenceId],
                    explanation:
                      index === 0
                        ? "A focused contract clarification remains."
                        : "Deterministic verification supports the criterion.",
                  }),
                ),
                scopeAssessment: {
                  withinScope: true,
                  unexpectedFiles: [],
                  explanation: "Only the diagnosed implementation and regression test changed.",
                },
                createdAt: "2026-08-02T12:04:00.000Z",
              }
            : {
                schemaVersion: 1,
                taskId: seeded.task.id,
                sourceCommit: seeded.sourceCommit,
                reviewedDiffHash: diff.diffHash,
                verdict: "approve",
                findings: [],
                acceptanceCriteriaAssessment: seeded.task.acceptanceCriteria.map((criterion) => ({
                  criterionId: criterion.id,
                  status: "met",
                  evidenceIds: [evidenceId],
                  explanation:
                    "The exact corrected diff and deterministic test evidence satisfy it.",
                })),
                scopeAssessment: {
                  withinScope: true,
                  unexpectedFiles: [],
                  explanation: "The correction remains within the diagnosed files.",
                },
                createdAt: "2026-08-02T12:06:00.000Z",
              };
        const threadId = `reviewer-thread-${reviewCalls}`;
        threadIds.push(threadId);
        return agentResponse(request, output, threadId);
      },
    };

    const report = await createReviewService(seeded, runtime).review(seeded.task.id);

    expect(report.task.status).toBe("completed");
    expect(roles).toEqual(["reviewer", "corrector", "reviewer"]);
    expect(sandboxes).toEqual(["read-only", "workspace-write", "read-only"]);
    expect(threadIds).toEqual([
      "reviewer-thread-1",
      "review-correction-thread",
      "reviewer-thread-2",
    ]);
    expect(report.reviews).toHaveLength(2);
    expect(report.corrections).toHaveLength(1);
    expect(report.reviews[0]?.reviewedDiffHash).not.toBe(report.reviews[1]?.reviewedDiffHash);
    expect(report.reviews[1]?.reviewedDiffHash).toBe(report.diff.diffHash);
    expect(report.verification.diffHash).toBe(report.diff.diffHash);
    expect(report.usage.totalCalls).toBe(4);
    expect(
      (await new ReviewFileRepository(seeded.paths).read("demo", seeded.task.id)).verdict,
    ).toBe("approve");
    expect(await readFile(join(fixture, "index.js"), "utf8")).toBe(
      "export const publicValue = 1;\n",
    );
    expect(await gitOutput(fixture, ["rev-parse", "HEAD"])).toBe(beforeHead);
    expect(await gitOutput(fixture, ["status", "--porcelain=v1"])).toBe(beforeStatus);
  });

  it("invalidates verification and blocks before review when the worktree diff changes", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "cxo-stale-review-fixture-"));
    const stateHome = await mkdtemp(join(tmpdir(), "cxo-stale-review-state-"));
    temporaryDirectories.push(fixture, stateHome);
    await createGitFixture(fixture);
    const seeded = await createImplementedTaskFixture(fixture, stateHome);
    await writeFile(
      join(seeded.runReport.task.worktree?.path ?? "", "index.js"),
      "export const publicValue = 99;\n",
      "utf8",
    );
    let calls = 0;
    const runtime: CodexRuntime = {
      runStructured: () => {
        calls += 1;
        throw new Error("reviewer should not run for a stale diff");
      },
    };

    await expect(createReviewService(seeded, runtime).review(seeded.task.id)).rejects.toMatchObject(
      {
        code: "CONTEXT_INTEGRITY",
        message: "The worktree diff changed after capture",
      },
    );

    expect(calls).toBe(0);
    expect((await seeded.taskRepository.getState(seeded.task.id)).status).toBe("blocked");
  });
});

type Implemented = Awaited<ReturnType<typeof createImplementedTaskFixture>>;

function createReviewService(seeded: Implemented, runtime: CodexRuntime): TaskReviewService {
  return new TaskReviewService(
    seeded.config,
    seeded.paths,
    seeded.taskRepository,
    seeded.projects,
    runtime,
    new UsageFileRepository(seeded.paths),
    seeded.diagnosisRepository,
    new EvidenceFileRepository(seeded.paths),
    new ExecutionFileRepository(seeded.paths),
    new DecisionFileRepository(seeded.paths),
    new VerificationFileRepository(seeded.paths),
    new ReviewFileRepository(seeded.paths),
    { now: () => new Date("2026-08-02T12:07:00.000Z") },
  );
}

function agentResponse<T>(
  request: CodexRunRequest<T>,
  output: unknown,
  threadId: string,
): CodexRunResult<T> {
  return {
    threadId,
    output: request.outputValidator.parse(output),
    eventsPath: request.eventsPath,
    usage: {
      inputTokens: 900,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 200,
      reasoningOutputTokens: 30,
      totalTokens: 1_100,
      source: "actual",
    },
    finalResponse: JSON.stringify(output),
    runtimeAttempts: 1,
    compatibility: {
      sdkVersion: "0.146.0",
      requestedReasoning: request.reasoningPreset,
      mappedReasoning: request.reasoningPreset === "deepest" ? "xhigh" : request.reasoningPreset,
      fallbackApplied: false,
      missingUsageFields: [],
    },
  };
}
