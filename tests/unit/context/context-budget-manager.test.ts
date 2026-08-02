import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../../src/application/configuration/default-config.js";
import { StatePaths } from "../../../src/infrastructure/persistence/state-paths.js";
import { UsageFileRepository } from "../../../src/infrastructure/persistence/usage-file-repository.js";
import { ContextBudgetManager } from "../../../src/orchestration/context/context-budget-manager.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true })),
  );
});

describe("ContextBudgetManager", () => {
  it("blocks a call beyond the hard context limit before reserving usage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cxo-budget-"));
    temporaryDirectories.push(directory);
    const usage = new UsageFileRepository(new StatePaths({ CODEX_ORCHESTRATOR_HOME: directory }));
    const manager = new ContextBudgetManager(DEFAULT_CONFIG, usage);

    await expect(
      manager.admitAndReserve({
        projectId: "demo",
        taskId: "BUG-2026-0001",
        phase: "diagnosis",
        profile: "balanced",
        estimatedInputTokens: DEFAULT_CONFIG.context.estimatedInputHardLimit + 1,
        activeParallelReaders: 0,
      }),
    ).rejects.toMatchObject({ code: "BUDGET" });
    expect((await usage.read("demo", "BUG-2026-0001")).reservations).toEqual([]);
  });

  it("atomically shares one task budget across parallel workers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cxo-budget-"));
    temporaryDirectories.push(directory);
    const usage = new UsageFileRepository(new StatePaths({ CODEX_ORCHESTRATOR_HOME: directory }));
    const config = {
      ...DEFAULT_CONFIG,
      context: { ...DEFAULT_CONFIG.context, reservedOutputTokens: 10 },
      profiles: {
        ...DEFAULT_CONFIG.profiles,
        balanced: { ...DEFAULT_CONFIG.profiles.balanced, maxTotalTokens: 100, maxAgentCalls: 2 },
      },
    };
    const manager = new ContextBudgetManager(config, usage);
    const attempt = (workerId: string) =>
      manager.admitAndReserve({
        projectId: "demo",
        taskId: "BUG-2026-0001",
        phase: "exploration",
        profile: "balanced",
        estimatedInputTokens: 50,
        activeParallelReaders: 2,
        workerId,
      });

    const settled = await Promise.allSettled([attempt("worker-a"), attempt("worker-b")]);

    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
    const ledger = await usage.read("demo", "BUG-2026-0001");
    expect(ledger.reservations).toHaveLength(1);
    expect(ledger.reservations[0]?.projectedTokens).toBe(60);
    expect(ledger.reservations[0]?.projectedCalls).toBe(1);
  });

  it("reserves compatibility fallback calls before runtime execution", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cxo-budget-"));
    temporaryDirectories.push(directory);
    const usage = new UsageFileRepository(new StatePaths({ CODEX_ORCHESTRATOR_HOME: directory }));
    const config = {
      ...DEFAULT_CONFIG,
      profiles: {
        ...DEFAULT_CONFIG.profiles,
        economy: { ...DEFAULT_CONFIG.profiles.economy, maxAgentCalls: 1 },
      },
    };
    const manager = new ContextBudgetManager(config, usage);

    await expect(
      manager.admitAndReserve({
        projectId: "demo",
        taskId: "BUG-2026-0001",
        phase: "diagnosis",
        profile: "economy",
        estimatedInputTokens: 1_000,
        activeParallelReaders: 0,
        projectedAgentCalls: 2,
      }),
    ).rejects.toMatchObject({ code: "BUDGET" });
  });

  it("reserves worst-case token capacity for fallback or output repair", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cxo-budget-"));
    temporaryDirectories.push(directory);
    const usage = new UsageFileRepository(new StatePaths({ CODEX_ORCHESTRATOR_HOME: directory }));
    const config = {
      ...DEFAULT_CONFIG,
      context: { ...DEFAULT_CONFIG.context, reservedOutputTokens: 1_000 },
      profiles: {
        ...DEFAULT_CONFIG.profiles,
        balanced: {
          ...DEFAULT_CONFIG.profiles.balanced,
          maxTotalTokens: 3_999,
          maxAgentCalls: 2,
        },
      },
    };

    await expect(
      new ContextBudgetManager(config, usage).admitAndReserve({
        projectId: "demo",
        taskId: "BUG-2026-0001",
        phase: "diagnosis",
        profile: "balanced",
        estimatedInputTokens: 1_000,
        activeParallelReaders: 0,
        projectedAgentCalls: 2,
      }),
    ).rejects.toMatchObject({ code: "BUDGET" });
    expect((await usage.read("demo", "BUG-2026-0001")).reservations).toEqual([]);
  });
});
