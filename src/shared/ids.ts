import type { TaskType } from "../domain/task/task.js";

const TASK_PREFIX: Readonly<Record<TaskType, string>> = {
  bugfix: "BUG",
  feature: "FEAT",
  refactor: "REF",
  maintenance: "MAINT",
  investigation: "INV",
  review: "REV",
  test: "TEST",
  documentation: "DOC",
  audit: "AUDIT",
};

export function taskCounterKey(type: TaskType, year: number): string {
  return `${TASK_PREFIX[type]}-${year}`;
}

export function formatTaskId(type: TaskType, year: number, sequence: number): string {
  if (!Number.isInteger(year) || year < 2000 || year > 9999) {
    throw new RangeError("Task ID year must be a four-digit year");
  }
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > 999_999) {
    throw new RangeError("Task ID sequence must be between 1 and 999999");
  }
  return `${taskCounterKey(type, year)}-${sequence.toString().padStart(4, "0")}`;
}
