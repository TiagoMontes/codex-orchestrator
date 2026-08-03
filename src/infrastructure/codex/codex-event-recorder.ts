import { dirname } from "node:path";
import { mkdir, open, stat } from "node:fs/promises";
import type { ThreadEvent } from "@openai/codex-sdk";
import type { Clock } from "../../shared/clock.js";
import { systemClock } from "../../shared/clock.js";
import { LogRedactor } from "../process/log-redactor.js";

export type RuntimeApplicationEvent = { type: `runtime.${string}`; [key: string]: unknown };
export type RecordedRuntimeEvent = ThreadEvent | RuntimeApplicationEvent;

export class CodexEventRecorder {
  private bytesWritten: number | undefined;
  private truncated = false;

  constructor(
    readonly path: string,
    private readonly maxBytes = 10_000_000,
    private readonly redactor = new LogRedactor(),
    private readonly clock: Clock = systemClock,
  ) {}

  async record(event: RecordedRuntimeEvent): Promise<void> {
    const terminal = isTerminalEvent(event);
    if (this.truncated && !terminal) return;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    this.bytesWritten ??= await stat(this.path)
      .then((value) => value.size)
      .catch(() => 0);
    const record = {
      schemaVersion: 1,
      observedAt: this.clock.now().toISOString(),
      type: event.type,
      payload: sanitizeEvent(event, this.redactor),
    };
    const line = `${JSON.stringify(record)}\n`;
    const size = Buffer.byteLength(line);
    const terminalReserve = Math.min(64 * 1_024, Math.floor(this.maxBytes / 2));
    const normalLimit = this.maxBytes - terminalReserve;
    if (!terminal && this.bytesWritten + size > normalLimit) {
      this.truncated = true;
      await this.appendIfWithinLimit(
        `${JSON.stringify({
          schemaVersion: 1,
          observedAt: this.clock.now().toISOString(),
          type: "runtime.event_log_truncated",
          payload: { maxBytes: this.maxBytes },
        })}\n`,
        normalLimit,
      );
      return;
    }
    if (this.bytesWritten + size > this.maxBytes) return;
    await this.append(line);
  }

  private async appendIfWithinLimit(line: string, limit: number): Promise<void> {
    this.bytesWritten ??= 0;
    if (this.bytesWritten + Buffer.byteLength(line) > limit) return;
    await this.append(line);
  }

  private async append(line: string): Promise<void> {
    const handle = await open(this.path, "a", 0o600);
    try {
      await handle.writeFile(line, "utf8");
      this.bytesWritten = (this.bytesWritten ?? 0) + Buffer.byteLength(line);
    } finally {
      await handle.close();
    }
  }
}

function sanitizeEvent(
  event: RecordedRuntimeEvent,
  redactor: LogRedactor,
): Record<string, unknown> {
  if (
    event.type === "item.started" ||
    event.type === "item.updated" ||
    event.type === "item.completed"
  ) {
    const item = event.item;
    if (item.type === "reasoning") {
      return { item: { id: item.id, type: item.type, redacted: true } };
    }
    if (item.type === "command_execution") {
      return {
        item: {
          id: item.id,
          type: item.type,
          command: redactor.redact(item.command).slice(0, 4_000),
          aggregated_output: redactor.redact(item.aggregated_output).slice(-4_000),
          status: item.status,
          ...(item.exit_code === undefined ? {} : { exit_code: item.exit_code }),
        },
      };
    }
    if (item.type === "mcp_tool_call") {
      return {
        item: {
          id: item.id,
          type: item.type,
          server: item.server,
          tool: item.tool,
          status: item.status,
        },
      };
    }
    if (item.type === "agent_message") {
      return {
        item: {
          id: item.id,
          type: item.type,
          text: redactor.redact(item.text).slice(0, 8_000),
        },
      };
    }
    return JSON.parse(redactor.redact(JSON.stringify({ item }))) as Record<string, unknown>;
  }
  const serialized = redactor.redact(JSON.stringify(event));
  if (serialized.length > 8_000) {
    return { truncated: true, summary: serialized.slice(0, 8_000) };
  }
  return JSON.parse(serialized) as Record<string, unknown>;
}

function isTerminalEvent(event: RecordedRuntimeEvent): boolean {
  return (
    event.type === "turn.completed" ||
    event.type === "turn.failed" ||
    event.type === "error" ||
    event.type === "runtime.compatibility" ||
    event.type === "runtime.cancelled" ||
    event.type === "runtime.timeout"
  );
}
