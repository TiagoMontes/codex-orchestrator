import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../../src/application/configuration/default-config.js";
import { CommandRunner } from "../../../src/infrastructure/process/command-runner.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true })),
  );
});

describe("CommandRunner", () => {
  it("uses literal argv, sanitizes environment, and redacts logs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cxo-command-runner-"));
    temporaryDirectories.push(directory);
    const marker = join(directory, "must-not-exist");
    const injected = `; touch ${marker}`;
    const runner = new CommandRunner(DEFAULT_CONFIG);
    const result = await runner.run({
      argv: [
        process.execPath,
        "-e",
        'console.log(process.argv[1]); console.log(process.env.SECRET_TOKEN ?? "absent"); console.log("Bearer top-secret")',
        injected,
      ],
      cwd: directory,
      timeoutMs: 5_000,
      logPath: join(directory, "command.log"),
      environment: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        SECRET_TOKEN: "environment-secret",
      },
    });

    const log = await readFile(result.logPath, "utf8");
    expect(result.exitCode).toBe(0);
    expect(log).toContain(injected);
    expect(log).toContain("absent");
    expect(log).toContain("Bearer [REDACTED]");
    expect(log).not.toContain("top-secret");
    expect(log).not.toContain("environment-secret");
    await expect(access(marker)).rejects.toBeDefined();
  });

  it("caps logs and never treats a timeout as success", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cxo-command-cap-"));
    temporaryDirectories.push(directory);
    const config = {
      ...DEFAULT_CONFIG,
      storage: { ...DEFAULT_CONFIG.storage, maxCommandLogBytes: 256 },
      context: { ...DEFAULT_CONFIG.context, maxExcerptCharacters: 80 },
    };
    const runner = new CommandRunner(config);
    const capped = await runner.run({
      argv: [process.execPath, "-e", 'console.log("x".repeat(5000))'],
      cwd: directory,
      timeoutMs: 5_000,
      logPath: join(directory, "capped.log"),
    });
    const timedOut = await runner.run({
      argv: [process.execPath, "-e", "setTimeout(() => {}, 5000)"],
      cwd: directory,
      timeoutMs: 50,
      logPath: join(directory, "timeout.log"),
    });

    expect((await stat(capped.logPath)).size).toBeLessThanOrEqual(256);
    expect(capped.excerpt.length).toBeLessThanOrEqual(80);
    expect(timedOut.timedOut).toBe(true);
    expect(timedOut.exitCode === 0 && timedOut.signal === undefined).toBe(false);
  });
});
