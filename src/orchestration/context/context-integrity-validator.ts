import { readFile } from "node:fs/promises";
import type { Project } from "../../domain/project/project.js";
import type { Task } from "../../domain/task/task.js";
import { hashJson, sha256 } from "../../shared/hashing.js";
import { OrchestratorError } from "../../shared/errors.js";
import type { ContextPack } from "./context-pack.js";

export type CurrentContextIntegrity = {
  task: Task;
  project: Project;
  sourceCommit: string;
  worktreeHead?: string;
  diagnosis?: unknown;
  diffHash?: string;
};

export class ContextIntegrityValidator {
  assertValid(pack: ContextPack, current: CurrentContextIntegrity): void {
    const mismatches: string[] = [];
    if (pack.contextPackVersion !== 1) mismatches.push("context-pack version");
    if (pack.task.id !== current.task.id || pack.task.hash !== hashJson(current.task))
      mismatches.push("task hash");
    if (pack.projectId !== current.project.id) mismatches.push("project ID");
    if (pack.sourceCommit !== current.sourceCommit) mismatches.push("source commit");
    if (pack.acceptanceCriteriaHash !== hashJson(current.task.acceptanceCriteria)) {
      mismatches.push("acceptance criteria");
    }
    if (pack.worktreeHead !== current.worktreeHead) mismatches.push("worktree HEAD");
    if (pack.diffHash !== current.diffHash) mismatches.push("diff hash");
    const expectedDiagnosis =
      current.diagnosis === undefined ? undefined : hashJson(current.diagnosis);
    if (pack.diagnosisHash !== expectedDiagnosis) mismatches.push("diagnosis hash");
    const currentInstructions = new Map(
      current.project.instructionFiles.map((item) => [item.relativePath, item.sha256]),
    );
    if (
      pack.instructionHashes.some((item) => currentInstructions.get(item.path) !== item.sha256) ||
      pack.instructionHashes.length !== currentInstructions.size
    ) {
      mismatches.push("instruction files");
    }
    if (mismatches.length > 0) {
      throw new OrchestratorError(`Context integrity violation: ${mismatches.join(", ")}`, {
        code: "CONTEXT_INTEGRITY",
        resumable: true,
      });
    }
  }

  async assertLiveInstructionFiles(
    pack: ContextPack,
    current: CurrentContextIntegrity,
  ): Promise<void> {
    this.assertValid(pack, current);
    const expected = new Map(pack.instructionHashes.map((item) => [item.path, item.sha256]));
    const stale: string[] = [];
    await Promise.all(
      current.project.instructionFiles.map(async (item) => {
        const actual = await readFile(item.path)
          .then(sha256)
          .catch(() => undefined);
        if (actual === undefined || actual !== expected.get(item.relativePath))
          stale.push(item.relativePath);
      }),
    );
    if (stale.length > 0) {
      throw new OrchestratorError(
        `Context integrity violation: instruction files changed (${stale.join(", ")})`,
        {
          code: "CONTEXT_INTEGRITY",
          resumable: true,
        },
      );
    }
  }
}
