import type { TaskFileRepository } from "../../infrastructure/persistence/task-file-repository.js";
import { OrchestratorError } from "../../shared/errors.js";

export class PersistedTaskCancellation {
  private readonly controller = new AbortController();
  private readonly timer: NodeJS.Timeout;
  private readonly forwardAbort: () => void;

  constructor(
    private readonly tasks: TaskFileRepository,
    private readonly taskId: string,
    callerSignal?: AbortSignal,
    pollIntervalMs = 100,
  ) {
    this.forwardAbort = (): void =>
      this.controller.abort(callerSignal?.reason ?? new Error("Caller cancelled the task"));
    callerSignal?.addEventListener("abort", this.forwardAbort, { once: true });
    if (callerSignal?.aborted ?? false) this.forwardAbort();
    this.timer = setInterval(() => void this.poll(), pollIntervalMs);
    this.timer.unref();
    void this.poll();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  dispose(callerSignal?: AbortSignal): void {
    clearInterval(this.timer);
    callerSignal?.removeEventListener("abort", this.forwardAbort);
  }

  private async poll(): Promise<void> {
    if (this.controller.signal.aborted) return;
    try {
      const state = await this.tasks.getState(this.taskId);
      if (state.status === "cancelled") {
        this.controller.abort(new Error(`Task ${this.taskId} was cancelled`));
      }
    } catch (error) {
      this.controller.abort(
        new OrchestratorError(`Unable to validate cancellation state for ${this.taskId}`, {
          code: "CONTEXT_INTEGRITY",
          resumable: true,
          cause: error,
        }),
      );
    }
  }
}
