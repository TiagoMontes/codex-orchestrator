import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitCommandLog } from "../../../src/infrastructure/git/git-command-log.js";
import { GitClientFactory } from "../../../src/infrastructure/git/git-client-factory.js";
import { StatePaths } from "../../../src/infrastructure/persistence/state-paths.js";
import { ConfigService } from "../../../src/application/configuration/config-service.js";
import { DEFAULT_CONFIG } from "../../../src/application/configuration/default-config.js";
import { LocalDoctorSystem } from "../../../src/application/doctor/local-doctor-system.js";
import { stringify } from "yaml";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true })),
  );
});

describe("GitCommandLog", () => {
  it("serializes concurrent records, redacts arguments, and respects its byte cap", async () => {
    const home = await mkdtemp(join(tmpdir(), "cxo-git-log-"));
    temporaryDirectories.push(home);
    const paths = new StatePaths({ CODEX_ORCHESTRATOR_HOME: home });
    const log = new GitCommandLog(paths, 1_000);
    const timestamp = "2026-08-02T12:00:00.000Z";

    await Promise.all(
      Array.from({ length: 20 }, async (_, index) =>
        log.appendGlobal({
          cwd: "/tmp/repository",
          argv: ["git", "remote", "https://user:secret@example.test/repo.git", String(index)],
          startedAt: timestamp,
          completedAt: timestamp,
          exitCode: 0,
          stderrExcerpt: "Bearer secret-value",
        }),
      ),
    );

    const path = log.globalPath();
    const contents = await readFile(path, "utf8");
    const records = contents
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { schemaVersion: number; exitCode: number });
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((record) => record.schemaVersion === 1 && record.exitCode === 0)).toBe(
      true,
    );
    expect(contents).not.toContain("secret-value");
    expect(contents).not.toContain("user:secret");
    expect((await stat(path)).size).toBeLessThanOrEqual(1_000);
  });

  it("uses the configured cap and records scoped correlation plus doctor Git commands", async () => {
    const home = await mkdtemp(join(tmpdir(), "cxo-git-scopes-"));
    temporaryDirectories.push(home);
    const paths = new StatePaths({ CODEX_ORCHESTRATOR_HOME: home });
    const config = new ConfigService(paths);
    await config.initialize();
    const maximumBytes = 1_200;
    await writeFile(
      paths.configFile,
      stringify({
        ...structuredClone(DEFAULT_CONFIG),
        storage: { ...DEFAULT_CONFIG.storage, maxCommandLogBytes: maximumBytes },
      }),
      "utf8",
    );
    const clients = new GitClientFactory(paths);
    const taskClient = clients.task("demo", "BUG-2026-0001", {
      phase: "verification",
      executionId: "execution-1",
      threadId: "thread-1",
    });
    await Promise.all(Array.from({ length: 12 }, async () => taskClient.gitVersion()));
    await clients.project("demo", { phase: "project-refresh" }).gitVersion();
    await new LocalDoctorSystem(config, paths).checks();

    const taskPath = new GitCommandLog(paths).path("demo", "BUG-2026-0001");
    const taskRecords = (await readFile(taskPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(taskRecords.length).toBeGreaterThan(0);
    expect(taskRecords[0]).toMatchObject({
      scope: "task",
      projectId: "demo",
      taskId: "BUG-2026-0001",
      phase: "verification",
      executionId: "execution-1",
      threadId: "thread-1",
    });
    expect((await stat(taskPath)).size).toBeLessThanOrEqual(maximumBytes);
    expect(await readFile(new GitCommandLog(paths).projectPath("demo"), "utf8")).toContain(
      '"phase":"project-refresh"',
    );
    expect(await readFile(new GitCommandLog(paths).globalPath(), "utf8")).toContain(
      '"phase":"doctor"',
    );
  });
});
