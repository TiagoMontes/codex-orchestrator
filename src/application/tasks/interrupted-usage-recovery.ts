import type { Task } from "../../domain/task/task.js";
import type { ExecutionFileRepository } from "../../infrastructure/persistence/execution-file-repository.js";
import type { UsageFileRepository } from "../../infrastructure/persistence/usage-file-repository.js";

export async function recoverInterruptedUsage(
  task: Task,
  usage: UsageFileRepository | undefined,
  executions: ExecutionFileRepository | undefined,
): Promise<void> {
  if (usage === undefined) return;
  if (executions !== undefined) {
    const attemptsByReservation = new Map(
      (await executions.list(task.projectId, task.id))
        .filter(
          (attempt) => attempt.reservationId !== undefined && attempt.callStartedAt !== undefined,
        )
        .map((attempt) => [attempt.reservationId as string, attempt]),
    );
    const ledger = await usage.read(task.projectId, task.id);
    for (const reservation of ledger.reservations) {
      const attempt = attemptsByReservation.get(reservation.id);
      if (attempt === undefined) continue;
      await usage.commitFailedReservation({
        projectId: task.projectId,
        taskId: task.id,
        reservationId: reservation.id,
        model: attempt.modelDecision.model,
        reasoning: attempt.modelDecision.reasoning,
        ...(attempt.threadId === undefined ? {} : { threadId: attempt.threadId }),
      });
    }
  }
  // A reservation without any persisted attempt was admitted before a call started,
  // so it can be released. Every attached reservation was charged above, regardless
  // of whether a phase catch managed to terminalize the attempt before crashing.
  await usage.releaseAllReservations(task.projectId, task.id);
}
