import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Project } from "../../domain/project/project.js";
import type { Task } from "../../domain/task/task.js";
import { hashJson, sha256 } from "../../shared/hashing.js";
import { OrchestratorError } from "../../shared/errors.js";
import type { ContextPack } from "./context-pack.js";
import { ProjectMetadataScanner } from "../../application/projects/project-metadata-scanner.js";

export type CurrentContextIntegrity = {
  task: Task;
  project: Project;
  sourceCommit: string;
  worktreeHead?: string;
  diagnosis?: unknown;
  verification?: unknown;
  diffHash?: string;
};

export class ContextIntegrityValidator {
  assertValid(pack: ContextPack, current: CurrentContextIntegrity): void {
    const mismatches: string[] = [];
    if (pack.contextPackVersion !== 2) mismatches.push("context-pack version");
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
    const expectedVerification =
      current.verification === undefined ? undefined : hashJson(current.verification);
    if (pack.verificationHash !== expectedVerification) mismatches.push("verification hash");
    const currentInstructions = new Map(
      current.project.instructionFiles.map((item) => [item.relativePath, item.sha256]),
    );
    if (
      pack.instructionHashes.some((item) => currentInstructions.get(item.path) !== item.sha256) ||
      pack.instructionHashes.length !== currentInstructions.size
    ) {
      mismatches.push("instruction files");
    }
    if (
      pack.selectedSkills.some((skill) => sha256(skill.instructions) !== skill.instructionsSha256)
    ) {
      mismatches.push("selected skill instructions");
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
    instructionRoot = current.project.gitRoot,
  ): Promise<void> {
    this.assertValid(pack, current);
    const expected = new Map(
      pack.instructionHashes.map((item) => [normalizeRelative(item.path), item.sha256]),
    );
    const stale: string[] = [];
    const liveMetadata = await new ProjectMetadataScanner().scan(instructionRoot);
    const liveInstructions = new Map(
      liveMetadata.instructionFiles.map((item) => [
        normalizeRelative(item.relativePath),
        item.sha256,
      ]),
    );
    for (const [path, expectedHash] of expected) {
      if (liveInstructions.get(path) !== expectedHash) stale.push(path);
    }
    for (const path of liveInstructions.keys()) {
      if (!expected.has(path)) stale.push(path);
    }
    await Promise.all(
      pack.selectedSkills.map(async (skill) => {
        const path =
          skill.source === "project"
            ? join(instructionRoot, relative(current.project.gitRoot, skill.path))
            : skill.path;
        const actual = await readFile(path)
          .then(sha256)
          .catch(() => undefined);
        if (actual === undefined || actual !== skill.sha256) stale.push(`skill:${skill.name}`);
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

function normalizeRelative(path: string): string {
  return path.split(/[\\/]/u).join("/");
}
