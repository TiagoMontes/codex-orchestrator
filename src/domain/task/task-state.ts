import { z } from "zod";
import { taskStatusSchema, type TaskStatus } from "./task.js";

export const allowedTaskTransitions: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  created: ["normalizing", "blocked", "cancelled", "failed"],
  normalizing: ["ready-for-diagnosis", "blocked", "failed", "cancelled"],
  "ready-for-diagnosis": ["diagnosing", "blocked", "cancelled", "failed"],
  diagnosing: ["diagnosed", "blocked", "failed", "cancelled"],
  diagnosed: ["worktree-preparing", "blocked", "cancelled", "failed"],
  "worktree-preparing": ["ready-for-implementation", "blocked", "failed", "cancelled"],
  "ready-for-implementation": [
    "worktree-preparing",
    "implementing",
    "blocked",
    "cancelled",
    "failed",
  ],
  implementing: ["verifying", "blocked", "failed", "cancelled"],
  verifying: ["implementing", "reviewing", "blocked", "failed", "cancelled"],
  reviewing: ["completed", "correcting", "blocked", "failed", "cancelled"],
  correcting: ["verifying", "blocked", "failed", "cancelled"],
  completed: [],
  blocked: [
    "normalizing",
    "ready-for-diagnosis",
    "ready-for-implementation",
    "reviewing",
    "cancelled",
    "failed",
  ],
  failed: [],
  cancelled: [
    "normalizing",
    "ready-for-diagnosis",
    "ready-for-implementation",
    "reviewing",
    "failed",
  ],
};

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return allowedTaskTransitions[from].includes(to);
}

export const taskTransitionSchema = z
  .object({
    previousState: taskStatusSchema,
    nextState: taskStatusSchema,
    timestamp: z.string().datetime(),
    reason: z.string().min(1),
    actor: z.enum(["system", "agent", "user"]),
    executionId: z.string().min(1).optional(),
  })
  .strict();

export const taskStateDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: z.string().min(1),
    status: taskStatusSchema,
    resumableFrom: taskStatusSchema.optional(),
    transitions: z.array(taskTransitionSchema),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type TaskTransition = z.infer<typeof taskTransitionSchema>;
export type TaskStateDocument = z.infer<typeof taskStateDocumentSchema>;
