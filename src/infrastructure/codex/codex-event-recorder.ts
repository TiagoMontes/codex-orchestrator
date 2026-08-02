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
    if (this.truncated) return;
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
    if (this.bytesWritten + size > this.maxBytes) {
      this.truncated = true;
      return;
    }
    const handle = await open(this.path, "a", 0o600);
    try {
      await handle.writeFile(line, "utf8");
      this.bytesWritten += size;
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
  return JSON.parse(redactor.redact(JSON.stringify(event))) as Record<string, unknown>;
}
