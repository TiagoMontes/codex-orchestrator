import type { TaskStateDocument, TaskTransition } from "../../domain/task/task-state.js";
import type { TaskStatus } from "../../domain/task/task.js";
import { canTransitionTask } from "../../domain/task/task-state.js";
import { OrchestratorError } from "../../shared/errors.js";

export type TransitionInput = Omit<TaskTransition, "previousState" | "timestamp"> & {
  timestamp: string;
};

export class TaskStateMachine {
  canTransition(from: TaskStatus, to: TaskStatus): boolean {
    return canTransitionTask(from, to);
  }

  transition(state: TaskStateDocument, input: TransitionInput): TaskStateDocument {
    if (!this.canTransition(state.status, input.nextState)) {
      throw new OrchestratorError(
        `Invalid task transition: ${state.status} -> ${input.nextState}`,
        {
          code: "TASK_STATE",
        },
      );
    }
    const transition: TaskTransition = {
      previousState: state.status,
      nextState: input.nextState,
      timestamp: input.timestamp,
      reason: input.reason,
      actor: input.actor,
      ...(input.executionId === undefined ? {} : { executionId: input.executionId }),
    };
    return {
      schemaVersion: state.schemaVersion,
      taskId: state.taskId,
      status: input.nextState,
      ...(input.nextState === "blocked" || input.nextState === "cancelled"
        ? {
            resumableFrom:
              state.status === "blocked" || state.status === "cancelled"
                ? (state.resumableFrom ?? state.status)
                : state.status,
          }
        : {}),
      transitions: [...state.transitions, transition],
      updatedAt: input.timestamp,
    };
  }
}
