import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexEventRecorder } from "../../../src/infrastructure/codex/codex-event-recorder.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true })),
  );
});

describe("CodexEventRecorder", () => {
  it("caps chatter while retaining a truncation marker and terminal usage events", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cxo-event-recorder-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "events.jsonl");
    const recorder = new CodexEventRecorder(path, 2_048);

    for (let index = 0; index < 20; index += 1) {
      await recorder.record({
        type: "runtime.chatter",
        index,
        text: "x".repeat(250),
      });
    }
    await recorder.record({
      type: "turn.completed",
      usage: {
        input_tokens: 100,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        output_tokens: 20,
        reasoning_output_tokens: 5,
      },
    });
    await recorder.record({ type: "runtime.compatibility", fallbackApplied: false });

    const records = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    expect(records.some((record) => record.type === "runtime.event_log_truncated")).toBe(true);
    expect(records.some((record) => record.type === "turn.completed")).toBe(true);
    expect(records.some((record) => record.type === "runtime.compatibility")).toBe(true);
    expect((await stat(path)).size).toBeLessThanOrEqual(2_048);
  });
});
