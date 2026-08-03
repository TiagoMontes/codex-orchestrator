import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
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

  it("does not spawn a command when its signal is already aborted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cxo-command-abort-"));
    temporaryDirectories.push(directory);
    const marker = join(directory, "must-not-exist");
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));

    const result = await new CommandRunner(DEFAULT_CONFIG).run({
      argv: [
        process.execPath,
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "bad")`,
      ],
      cwd: directory,
      timeoutMs: 5_000,
      logPath: join(directory, "aborted.log"),
      abortSignal: controller.signal,
    });

    expect(result).toMatchObject({ aborted: true, exitCode: null, timedOut: false });
    await expect(access(marker)).rejects.toBeDefined();
    expect(await readFile(result.logPath, "utf8")).toContain("command skipped");
  });

  it("contains filesystem writes and disables network while allowing worktree-local output", async () => {
    const root = await mkdtemp(join(tmpdir(), "cxo-command-containment-"));
    const workspace = join(root, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    temporaryDirectories.push(root);
    const outsideMarker = join(root, "outside-marker");
    const outsideSecret = join(root, "outside-secret");
    const localMarker = join(workspace, "local-marker");
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(outsideSecret, "credential-canary", "utf8"),
    );
    const runner = new CommandRunner(DEFAULT_CONFIG);

    const local = await runner.run({
      argv: [
        process.execPath,
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(localMarker)}, "ok")`,
      ],
      cwd: workspace,
      timeoutMs: 5_000,
      logPath: join(root, "local.log"),
    });
    const outside = await runner.run({
      argv: [
        process.execPath,
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(outsideMarker)}, "bad")`,
      ],
      cwd: workspace,
      timeoutMs: 5_000,
      logPath: join(root, "outside.log"),
    });
    const readOutside = await runner.run({
      argv: [
        process.execPath,
        "-e",
        `try{require("node:fs").readFileSync(${JSON.stringify(outsideSecret)});process.exit(42)}catch{process.exit(0)}`,
      ],
      cwd: workspace,
      timeoutMs: 5_000,
      logPath: join(root, "outside-read.log"),
    });

    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing TCP address");
    try {
      const network = await runner.run({
        argv: [
          process.execPath,
          "-e",
          `const s=require("node:net").connect(${address.port},"127.0.0.1");s.once("connect",()=>process.exit(42));s.once("error",()=>process.exit(0));setTimeout(()=>process.exit(43),1000)`,
        ],
        cwd: workspace,
        timeoutMs: 5_000,
        logPath: join(root, "network.log"),
      });
      expect(network.exitCode).toBe(0);
      expect(network.sandboxError).toBeUndefined();
    } finally {
      server.close();
    }

    expect(local.exitCode).toBe(0);
    expect(local.sandboxError).toBeUndefined();
    expect(outside.exitCode).not.toBe(0);
    expect(readOutside.exitCode).toBe(0);
    expect(await readFile(localMarker, "utf8")).toBe("ok");
    await expect(access(outsideMarker)).rejects.toBeDefined();
  });

  it("terminates the command process group before a descendant can outlive a timeout", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cxo-command-tree-"));
    temporaryDirectories.push(directory);
    const marker = join(directory, "late-child-marker");
    const result = await new CommandRunner(DEFAULT_CONFIG).run({
      argv: [
        process.execPath,
        "-e",
        `require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(`process.on("SIGTERM",()=>{});setTimeout(()=>require("node:fs").writeFileSync(${JSON.stringify(marker)},"bad"),1500);setInterval(()=>{},1000)`)}],{stdio:"inherit"});setInterval(()=>{},1000)`,
      ],
      cwd: directory,
      timeoutMs: 50,
      logPath: join(directory, "tree.log"),
    });
    await new Promise((resolve) => setTimeout(resolve, 1_700));

    expect(result.timedOut).toBe(true);
    await expect(access(marker)).rejects.toBeDefined();
  });

  it.skipIf(process.platform !== "darwin")(
    "settles within the hard deadline when a descendant attempts to keep pipes open",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "cxo-command-session-"));
      temporaryDirectories.push(directory);
      const started = Date.now();
      const result = await new CommandRunner(DEFAULT_CONFIG).run({
        argv: [
          process.execPath,
          "-e",
          'const child=require("node:child_process").spawn(process.execPath,["-e","setTimeout(()=>{},2300)"],{detached:true,stdio:"inherit"});child.unref()',
        ],
        cwd: directory,
        timeoutMs: 50,
        logPath: join(directory, "session.log"),
      });

      expect(Date.now() - started).toBeLessThan(3_000);
      expect(result).toMatchObject({ timedOut: true, exitCode: null });
      expect(result.signal).toMatch(/^SIG(?:TERM|KILL)$/u);
      if (result.sandboxError !== undefined) {
        expect(result.sandboxError).toContain("hard deadline");
      }
    },
    5_000,
  );
});
