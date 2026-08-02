import { OrchestratorError } from "../../shared/errors.js";

export function taskBranchName(taskId: string, title: string): string {
  const taskPart = taskId.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  const titlePart = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 72);
  if (taskPart === "") {
    throw new OrchestratorError("Cannot create a branch name from an empty task ID", {
      code: "TASK_STATE",
    });
  }
  return `codex/${taskPart}${titlePart === "" ? "" : `-${titlePart}`}`;
}
