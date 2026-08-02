import { describe, expect, it } from "vitest";
import type { TaskStateDocument } from "../../../src/domain/task/task-state.js";
import { TaskStateMachine } from "../../../src/orchestration/engine/state-machine.js";

const state: TaskStateDocument = {
  schemaVersion: 1,
  taskId: "BUG-2026-0001",
  status: "created",
  transitions: [],
  updatedAt: "2026-08-02T12:00:00.000Z",
};

describe("TaskStateMachine", () => {
  it("persists a valid transition with its actor and reason", () => {
    const next = new TaskStateMachine().transition(state, {
      nextState: "normalizing",
      timestamp: "2026-08-02T12:00:01.000Z",
      reason: "normalization requested",
      actor: "system",
    });

    expect(next.status).toBe("normalizing");
    expect(next.transitions[0]).toMatchObject({
      previousState: "created",
      nextState: "normalizing",
      actor: "system",
    });
  });

  it("rejects invalid transitions", () => {
    expect(() =>
      new TaskStateMachine().transition(state, {
        nextState: "completed",
        timestamp: "2026-08-02T12:00:01.000Z",
        reason: "invalid shortcut",
        actor: "system",
      }),
    ).toThrow("Invalid task transition");
  });
});
