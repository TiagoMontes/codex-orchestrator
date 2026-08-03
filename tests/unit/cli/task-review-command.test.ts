import { Command } from "commander";
import { describe, expect, it } from "vitest";
import type {
  TaskReporter,
  TaskStatusReport,
} from "../../../src/application/tasks/task-reporting-service.js";
import type {
  TaskReviewer,
  TaskReviewReport,
} from "../../../src/application/tasks/task-review-service.js";
import { registerTaskReviewCommand } from "../../../src/cli/commands/task-review.command.js";
import type { OutputWriter } from "../../../src/cli/output.js";

describe("task review command", () => {
  it("prints the complete safe final report in human mode", async () => {
    const lines: string[] = [];
    const output: OutputWriter = {
      write: (message) => lines.push(message),
      writeError: (message) => lines.push(`ERROR ${message}`),
    };
    const task = {
      id: "BUG-2026-0001",
      status: "completed",
      title: "Fix public value",
      summary: "Make the public value correct.",
      baseCommit: "a".repeat(40),
      worktree: { path: "/tmp/worktree", branch: "cxo/bug", baseCommit: "a".repeat(40) },
    };
    const reviewReport = {
      task,
      reviews: [
        {
          verdict: "approve",
          reviewedDiffHash: "b".repeat(64),
          findings: [],
        },
      ],
      corrections: [],
      verification: { overallStatus: "passed" },
      usage: { totals: { totalTokens: 123 }, totalCalls: 2 },
    } as unknown as TaskReviewReport;
    const status = {
      task,
      artifacts: {
        diagnosis: {
          status: "confirmed",
          nextAction: "Implement the confirmed fix",
          rootCauses: [{ statement: "The constant retained its old value" }],
        },
        diff: { changedFiles: ["index.js", "test/index.test.js"] },
        review: { acceptanceCriteriaAssessment: [{ criterionId: "AC-001", status: "met" }] },
      },
      retryCount: 1,
      retries: [
        { executionId: "writer-2", phase: "correction", attemptNumber: 2, reason: "test failed" },
      ],
      contextRotations: [
        {
          executionId: "review-2",
          phase: "review",
          compacted: true,
          reasons: ["fresh independent review"],
        },
      ],
      usageBreakdown: [{ phase: "review", model: "gpt-5.6", totalTokens: 123, calls: 2 }],
      limitations: ["No network access was enabled"],
      nextCommand: "cxo task status BUG-2026-0001",
    } as unknown as TaskStatusReport;
    const reviewer: TaskReviewer = {
      review: () => Promise.resolve(reviewReport),
    };
    const reporter = {
      status: () => Promise.resolve(status),
    } as unknown as TaskReporter;
    const program = new Command().name("cxo").option("--json");
    const taskCommand = new Command("task");
    program.addCommand(taskCommand);
    registerTaskReviewCommand(taskCommand, program, reviewer, output, reporter);

    await program.parseAsync(["node", "cxo", "task", "review", task.id]);

    expect(lines).toEqual(
      expect.arrayContaining([
        `Title: ${task.title}`,
        `Summary: ${task.summary}`,
        "Worktree: /tmp/worktree",
        "Diagnosis: confirmed; Implement the confirmed fix",
        "Root causes: The constant retained its old value",
        "Changed files: index.js, test/index.test.js",
        "Context rotation review/review-2: fresh independent review",
        "Next: cxo task status BUG-2026-0001",
      ]),
    );
    expect(lines.some((line) => line.includes("task inspect"))).toBe(false);
  });
});
