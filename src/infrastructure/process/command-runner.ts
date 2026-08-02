import { spawn } from "node:child_process";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { AppConfig } from "../../application/configuration/config-schema.js";
import type { Clock } from "../../shared/clock.js";
import { isoNow, systemClock } from "../../shared/clock.js";
import { OrchestratorError } from "../../shared/errors.js";
import { sha256 } from "../../shared/hashing.js";
import { canonicalizeExistingPath } from "../filesystem/path-safety.js";
import { EnvironmentSanitizer } from "./environment-sanitizer.js";
import { LogRedactor } from "./log-redactor.js";

export type CommandRunRequest = {
  argv: string[];
  cwd: string;
  timeoutMs: number;
  logPath: string;
  abortSignal?: AbortSignal;
  environment?: Readonly<Record<string, string | undefined>>;
};

export type CommandRunResult = {
  startedAt: string;
  completedAt: string;
  exitCode: number | null;
  signal?: string;
  timedOut: boolean;
  aborted: boolean;
  spawnError?: string;
  logPath: string;
  logSha256: string;
  excerpt: string;
};

export class CommandRunner {
  private readonly sanitizer: EnvironmentSanitizer;
  private readonly redactor = new LogRedactor();

  constructor(
    private readonly config: AppConfig,
    private readonly clock: Clock = systemClock,
  ) {
    this.sanitizer = new EnvironmentSanitizer(config.security.environmentAllowlist);
  }

  async run(request: CommandRunRequest): Promise<CommandRunResult> {
    if (request.argv.length === 0 || request.argv[0]?.trim() === "") {
      throw new OrchestratorError("Verification command argv cannot be empty", {
        code: "VERIFICATION",
      });
    }
    if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) {
      throw new OrchestratorError("Verification timeout must be positive", {
        code: "VERIFICATION",
      });
    }
    const cwd = await canonicalizeExistingPath(request.cwd);
    const startedAt = isoNow(this.clock);
    await mkdir(dirname(request.logPath), { recursive: true, mode: 0o700 });
    const log = await new BoundedRedactedLog(
      request.logPath,
      this.config.storage.maxCommandLogBytes,
      this.config.context.maxExcerptCharacters,
      this.redactor,
    ).open();
    if (request.abortSignal?.aborted ?? false) {
      log.push(
        "stderr",
        Buffer.from("[orchestrator] command skipped because execution was cancelled\n"),
      );
      const { excerpt, logSha256 } = await log.close();
      return {
        startedAt,
        completedAt: isoNow(this.clock),
        exitCode: null,
        timedOut: false,
        aborted: true,
        logPath: request.logPath,
        logSha256,
        excerpt,
      };
    }
    const environment = this.sanitizer.sanitize(request.environment ?? process.env).environment;
    const command = request.argv[0] as string;
    const args = request.argv.slice(1);
    let timedOut = false;
    let aborted = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const child = spawn(command, args, {
      cwd,
      env: environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk: Buffer) => log.push("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => log.push("stderr", chunk));

    const terminate = (reason: "timeout" | "abort"): void => {
      if (reason === "timeout") {
        if (timedOut) return;
        timedOut = true;
      } else {
        if (aborted) return;
        aborted = true;
      }
      if (!child.killed) child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 1_000);
      forceKillTimer.unref();
    };
    const timeout = setTimeout(() => terminate("timeout"), request.timeoutMs);
    timeout.unref();
    const abortListener = (): void => terminate("abort");
    request.abortSignal?.addEventListener("abort", abortListener, { once: true });
    if (request.abortSignal?.aborted ?? false) abortListener();

    const outcome = await new Promise<{
      exitCode: number | null;
      signal?: string;
      spawnError?: string;
    }>((resolve) => {
      let settled = false;
      const settle = (value: {
        exitCode: number | null;
        signal?: string;
        spawnError?: string;
      }): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      child.once("error", (error) =>
        settle({ exitCode: null, spawnError: this.redactor.redact(error.message) }),
      );
      child.once("close", (exitCode, signal) =>
        settle({
          exitCode,
          ...(signal === null ? {} : { signal }),
        }),
      );
    });
    clearTimeout(timeout);
    if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
    request.abortSignal?.removeEventListener("abort", abortListener);
    const { excerpt, logSha256 } = await log.close();
    return {
      startedAt,
      completedAt: isoNow(this.clock),
      exitCode: outcome.exitCode,
      ...(outcome.signal === undefined ? {} : { signal: outcome.signal }),
      timedOut,
      aborted,
      ...(outcome.spawnError === undefined ? {} : { spawnError: outcome.spawnError }),
      logPath: request.logPath,
      logSha256,
      excerpt,
    };
  }
}

class BoundedRedactedLog {
  private handle: Awaited<ReturnType<typeof open>> | undefined;
  private readonly stdoutDecoder = new StringDecoder("utf8");
  private readonly stderrDecoder = new StringDecoder("utf8");
  private stdoutPending = "";
  private stderrPending = "";
  private bytesWritten = 0;
  private excerpt = "";
  private writes = Promise.resolve();
  private truncated = false;

  constructor(
    private readonly path: string,
    private readonly maximumBytes: number,
    private readonly maximumExcerptCharacters: number,
    private readonly redactor: LogRedactor,
  ) {}

  async open(): Promise<this> {
    this.handle = await open(this.path, "w", 0o600);
    return this;
  }

  push(stream: "stdout" | "stderr", chunk: Buffer): void {
    const decoder = stream === "stdout" ? this.stdoutDecoder : this.stderrDecoder;
    if (stream === "stdout") this.stdoutPending += decoder.write(chunk);
    else this.stderrPending += decoder.write(chunk);
    this.flushCompleteLines(stream);
  }

  async close(): Promise<{ excerpt: string; logSha256: string }> {
    this.stdoutPending += this.stdoutDecoder.end();
    this.stderrPending += this.stderrDecoder.end();
    this.flush("stdout", this.stdoutPending);
    this.flush("stderr", this.stderrPending);
    if (this.truncated) this.enqueue("[orchestrator] command log truncated at configured cap\n");
    await this.writes;
    await this.handle?.sync();
    await this.handle?.close();
    this.handle = undefined;
    const contents = await readFile(this.path);
    return { excerpt: this.excerpt, logSha256: sha256(contents) };
  }

  private flushCompleteLines(stream: "stdout" | "stderr"): void {
    const pending = stream === "stdout" ? this.stdoutPending : this.stderrPending;
    const newline = pending.lastIndexOf("\n");
    if (newline >= 0) {
      this.flush(stream, pending.slice(0, newline + 1));
      if (stream === "stdout") this.stdoutPending = pending.slice(newline + 1);
      else this.stderrPending = pending.slice(newline + 1);
    } else if (pending.length > 65_536) {
      const boundary = pending.length - 4_096;
      this.flush(stream, pending.slice(0, boundary));
      if (stream === "stdout") this.stdoutPending = pending.slice(boundary);
      else this.stderrPending = pending.slice(boundary);
    }
  }

  private flush(stream: "stdout" | "stderr", value: string): void {
    if (value === "") return;
    this.enqueue(`[${stream}] ${this.redactor.redact(value)}`);
  }

  private enqueue(value: string): void {
    this.excerpt = `${this.excerpt}${value}`.slice(-this.maximumExcerptCharacters);
    if (this.bytesWritten >= this.maximumBytes) {
      this.truncated = true;
      return;
    }
    const buffer = Buffer.from(value, "utf8");
    const remaining = this.maximumBytes - this.bytesWritten;
    const bounded = buffer.subarray(0, remaining);
    this.bytesWritten += bounded.byteLength;
    if (bounded.byteLength < buffer.byteLength) this.truncated = true;
    this.writes = this.writes.then(async () => {
      await this.handle?.write(bounded);
    });
  }
}
