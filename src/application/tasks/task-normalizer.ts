import type { ExecutionProfile } from "../configuration/config-schema.js";
import type { TaskDraft } from "../../domain/task/task.js";
import type { CodexProgressObserver } from "../../infrastructure/codex/codex-runtime.js";

export type TaskNormalizationRequest = {
  taskId: string;
  projectId: string;
  profile: ExecutionProfile;
  originalFeedback: string;
  workingDirectory: string;
  additionalAllowedEnvironmentNames?: readonly string[];
  explicitSecretEnvironmentExceptions?: readonly string[];
  progress?: CodexProgressObserver;
  abortSignal?: AbortSignal;
};

export interface TaskNormalizer {
  normalize(request: TaskNormalizationRequest): Promise<TaskDraft>;
}
