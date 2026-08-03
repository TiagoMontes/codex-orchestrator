import { describe, expect, it } from "vitest";
import { PersistedTaskCancellation } from "../../../src/application/tasks/persisted-task-cancellation.js";
import type { TaskFileRepository } from "../../../src/infrastructure/persistence/task-file-repository.js";

describe("PersistedTaskCancellation", () => {
  it("waits for an in-flight state poll before disposal completes", async () => {
    let releasePoll!: () => void;
    const pollReleased = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });
    let signalStarted!: () => void;
    const pollStarted = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let polls = 0;
    const tasks = {
      getState: async () => {
        polls += 1;
        signalStarted();
        await pollReleased;
        return { status: "implementing" };
      },
    } as unknown as TaskFileRepository;
    const cancellation = new PersistedTaskCancellation(tasks, "BUG-2026-0001", undefined, 1);
    await pollStarted;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(polls).toBe(1);

    let disposed = false;
    const disposal = cancellation.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);

    releasePoll();
    await disposal;
    expect(disposed).toBe(true);
    expect(polls).toBe(1);
  });
});
