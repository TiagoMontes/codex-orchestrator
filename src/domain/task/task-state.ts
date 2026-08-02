import { z } from "zod";
import { taskStatusSchema } from "./task.js";

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
