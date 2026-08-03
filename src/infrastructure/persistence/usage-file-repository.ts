import { randomUUID } from "node:crypto";
import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import type { Clock } from "../../shared/clock.js";
import { isoNow, systemClock } from "../../shared/clock.js";
import { OrchestratorError } from "../../shared/errors.js";
import { stableJson } from "../../shared/hashing.js";
import type { ExecutionPhase } from "../../domain/execution/execution.js";
import type { NormalizedUsage } from "../../domain/usage/usage.js";
import { ZERO_ESTIMATED_USAGE } from "../../domain/usage/usage.js";
import {
  usageLedgerDocumentSchema,
  type UsageLedgerDocument,
  type UsageLedgerEntry,
  type UsageReservation,
} from "../../domain/usage/usage-ledger.js";
import type { ReasoningPreset } from "../../application/configuration/config-schema.js";
import { AtomicJsonStore } from "./atomic-json-store.js";
import { FileLockManager } from "./file-lock.js";
import type { StatePaths } from "./state-paths.js";

export class UsageFileRepository {
  private readonly locks: FileLockManager;

  constructor(
    private readonly paths: StatePaths,
    private readonly store = new AtomicJsonStore(),
    private readonly clock: Clock = systemClock,
  ) {
    this.locks = new FileLockManager(paths.locksDirectory);
  }

  async reserve(input: {
    projectId: string;
    taskId: string;
    phase: ExecutionPhase;
    projectedTokens: number;
    maxTotalTokens: number;
    maxAgentCalls: number;
    projectedCalls?: number;
    workerId?: string;
  }): Promise<UsageReservation> {
    const lock = await this.locks.acquire(`usage:${input.taskId}`);
    try {
      const ledger = await this.readOrCreate(input.projectId, input.taskId);
      const reservedTokens = ledger.reservations.reduce(
        (sum, reservation) => sum + reservation.projectedTokens,
        0,
      );
      if (
        ledger.totals.totalTokens + reservedTokens + input.projectedTokens >
        input.maxTotalTokens
      ) {
        throw new OrchestratorError("Task token budget would be exceeded", {
          code: "BUDGET",
          resumable: true,
        });
      }
      const reservedCalls = ledger.reservations.reduce(
        (sum, reservation) => sum + reservation.projectedCalls,
        0,
      );
      const projectedCalls = input.projectedCalls ?? 1;
      if (ledger.totalCalls + reservedCalls + projectedCalls > input.maxAgentCalls) {
        throw new OrchestratorError("Task agent-call budget would be exceeded", {
          code: "BUDGET",
          resumable: true,
        });
      }
      const reservation: UsageReservation = {
        id: randomUUID(),
        phase: input.phase,
        projectedTokens: input.projectedTokens,
        projectedCalls,
        ...(input.workerId === undefined ? {} : { workerId: input.workerId }),
        createdAt: isoNow(this.clock),
      };
      ledger.reservations.push(reservation);
      ledger.updatedAt = isoNow(this.clock);
      await this.write(input.projectId, input.taskId, ledger);
      return reservation;
    } finally {
      await lock.release();
    }
  }

  async commitReservation(input: {
    projectId: string;
    taskId: string;
    reservationId: string;
    model: string;
    reasoning: ReasoningPreset;
    usage: NormalizedUsage;
    agentCalls?: number;
    threadId?: string;
  }): Promise<UsageLedgerEntry> {
    const lock = await this.locks.acquire(`usage:${input.taskId}`);
    try {
      const ledger = await this.readOrCreate(input.projectId, input.taskId);
      const reservation = ledger.reservations.find((item) => item.id === input.reservationId);
      if (reservation === undefined) {
        const committed = ledger.entries.find(
          (entry) => entry.reservationId === input.reservationId,
        );
        if (committed !== undefined) {
          if (
            committed.model !== input.model ||
            committed.reasoning !== input.reasoning ||
            (!(committed.usage.source === "estimated" && input.usage.source === "actual") &&
              (committed.threadId ?? null) !== (input.threadId ?? null))
          ) {
            throw new OrchestratorError("Repeated usage commit metadata does not match", {
              code: "CONTEXT_INTEGRITY",
            });
          }
          if (committed.usage.source === "estimated" && input.usage.source === "actual") {
            if ((input.agentCalls ?? 1) > committed.agentCalls) {
              throw new OrchestratorError("Actual agent calls exceed the recovered reservation", {
                code: "BUDGET",
              });
            }
            const upgraded: UsageLedgerEntry = {
              ...committed,
              model: input.model,
              reasoning: input.reasoning,
              ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
              agentCalls: input.agentCalls ?? committed.agentCalls,
              usage: input.usage,
              recordedAt: isoNow(this.clock),
            };
            ledger.entries = ledger.entries.map((entry) =>
              entry.id === committed.id ? upgraded : entry,
            );
            ledger.totalCalls = ledger.entries.reduce(
              (total, entry) => total + entry.agentCalls,
              0,
            );
            ledger.totals = addUsage(ledger.entries.map((entry) => entry.usage));
            ledger.updatedAt = isoNow(this.clock);
            await this.write(input.projectId, input.taskId, ledger);
            return upgraded;
          }
          if (
            committed.agentCalls !== (input.agentCalls ?? 1) ||
            stableJson(committed.usage) !== stableJson(input.usage)
          ) {
            throw new OrchestratorError("Repeated actual usage commit does not match", {
              code: "CONTEXT_INTEGRITY",
            });
          }
          return committed;
        }
        throw new OrchestratorError(`Usage reservation not found: ${input.reservationId}`, {
          code: "BUDGET",
        });
      }
      const agentCalls = input.agentCalls ?? 1;
      if (agentCalls > reservation.projectedCalls) {
        throw new OrchestratorError("Actual agent calls exceed the admitted reservation", {
          code: "BUDGET",
        });
      }
      const entry: UsageLedgerEntry = {
        id: randomUUID(),
        reservationId: reservation.id,
        phase: reservation.phase,
        model: input.model,
        reasoning: input.reasoning,
        ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
        ...(reservation.workerId === undefined ? {} : { workerId: reservation.workerId }),
        agentCalls,
        usage: input.usage,
        recordedAt: isoNow(this.clock),
      };
      ledger.reservations = ledger.reservations.filter((item) => item.id !== reservation.id);
      ledger.entries.push(entry);
      ledger.totalCalls += agentCalls;
      ledger.totals = addUsage(ledger.entries.map((item) => item.usage));
      ledger.updatedAt = isoNow(this.clock);
      await this.write(input.projectId, input.taskId, ledger);
      return entry;
    } finally {
      await lock.release();
    }
  }

  async releaseReservation(
    projectId: string,
    taskId: string,
    reservationId: string,
  ): Promise<void> {
    const lock = await this.locks.acquire(`usage:${taskId}`);
    try {
      const ledger = await this.readOrCreate(projectId, taskId);
      ledger.reservations = ledger.reservations.filter((item) => item.id !== reservationId);
      ledger.updatedAt = isoNow(this.clock);
      await this.write(projectId, taskId, ledger);
    } finally {
      await lock.release();
    }
  }

  async commitFailedReservation(input: {
    projectId: string;
    taskId: string;
    reservationId: string;
    model: string;
    reasoning: ReasoningPreset;
    threadId?: string;
  }): Promise<UsageLedgerEntry> {
    const lock = await this.locks.acquire(`usage:${input.taskId}`);
    try {
      const ledger = await this.readOrCreate(input.projectId, input.taskId);
      const reservation = ledger.reservations.find((item) => item.id === input.reservationId);
      if (reservation === undefined) {
        const committed = ledger.entries.find(
          (entry) => entry.reservationId === input.reservationId,
        );
        if (committed !== undefined) {
          if (
            committed.model !== input.model ||
            committed.reasoning !== input.reasoning ||
            (input.threadId !== undefined && committed.threadId !== input.threadId)
          ) {
            throw new OrchestratorError("Repeated failed usage commit does not match", {
              code: "CONTEXT_INTEGRITY",
            });
          }
          return committed;
        }
        throw new OrchestratorError(`Usage reservation not found: ${input.reservationId}`, {
          code: "BUDGET",
        });
      }
      const usage: NormalizedUsage = {
        inputTokens: reservation.projectedTokens,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: reservation.projectedTokens,
        source: "estimated",
      };
      const entry: UsageLedgerEntry = {
        id: randomUUID(),
        reservationId: reservation.id,
        phase: reservation.phase,
        model: input.model,
        reasoning: input.reasoning,
        ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
        ...(reservation.workerId === undefined ? {} : { workerId: reservation.workerId }),
        agentCalls: reservation.projectedCalls,
        usage,
        recordedAt: isoNow(this.clock),
      };
      ledger.reservations = ledger.reservations.filter((item) => item.id !== reservation.id);
      ledger.entries.push(entry);
      ledger.totalCalls += reservation.projectedCalls;
      ledger.totals = addUsage(ledger.entries.map((item) => item.usage));
      ledger.updatedAt = isoNow(this.clock);
      await this.write(input.projectId, input.taskId, ledger);
      return entry;
    } finally {
      await lock.release();
    }
  }

  async releaseAllReservations(projectId: string, taskId: string): Promise<number> {
    const lock = await this.locks.acquire(`usage:${taskId}`);
    try {
      const ledger = await this.readOrCreate(projectId, taskId);
      const released = ledger.reservations.length;
      ledger.reservations = [];
      ledger.updatedAt = isoNow(this.clock);
      await this.write(projectId, taskId, ledger);
      return released;
    } finally {
      await lock.release();
    }
  }

  read(projectId: string, taskId: string): Promise<UsageLedgerDocument> {
    return this.readOrCreate(projectId, taskId);
  }

  private async readOrCreate(projectId: string, taskId: string): Promise<UsageLedgerDocument> {
    const path = this.path(projectId, taskId);
    if (!(await exists(path))) {
      return {
        schemaVersion: 1,
        taskId,
        projectId,
        entries: [],
        reservations: [],
        totals: ZERO_ESTIMATED_USAGE,
        totalCalls: 0,
        updatedAt: isoNow(this.clock),
      };
    }
    const ledger = await this.store.read(path, usageLedgerDocumentSchema);
    if (ledger.projectId !== projectId || ledger.taskId !== taskId) {
      throw new OrchestratorError("Usage ledger identity mismatch", { code: "CONTEXT_INTEGRITY" });
    }
    return ledger;
  }

  private write(projectId: string, taskId: string, ledger: UsageLedgerDocument): Promise<void> {
    return this.store.write(this.path(projectId, taskId), usageLedgerDocumentSchema.parse(ledger));
  }

  private path(projectId: string, taskId: string): string {
    return join(this.paths.taskDirectory(projectId, taskId), "usage.json");
  }
}

function addUsage(items: readonly NormalizedUsage[]): NormalizedUsage {
  return {
    inputTokens: sum(items, "inputTokens"),
    cachedInputTokens: sum(items, "cachedInputTokens"),
    cacheWriteInputTokens: sum(items, "cacheWriteInputTokens"),
    outputTokens: sum(items, "outputTokens"),
    reasoningOutputTokens: sum(items, "reasoningOutputTokens"),
    totalTokens: sum(items, "totalTokens"),
    source: items.every((item) => item.source === "actual") ? "actual" : "estimated",
  };
}

function sum(
  items: readonly NormalizedUsage[],
  field: keyof Omit<NormalizedUsage, "source">,
): number {
  return items.reduce((total, item) => total + item[field], 0);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
