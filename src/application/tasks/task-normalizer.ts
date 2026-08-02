import type { ExecutionProfile } from "../configuration/config-schema.js";
import type { TaskDraft } from "../../domain/task/task.js";

export type TaskNormalizationRequest = {
  taskId: string;
  projectId: string;
  profile: ExecutionProfile;
  originalFeedback: string;
  workingDirectory: string;
  abortSignal?: AbortSignal;
};

export interface TaskNormalizer {
  normalize(request: TaskNormalizationRequest): Promise<TaskDraft>;
}
