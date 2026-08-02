import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexOptions, ThreadEvent, ThreadOptions } from "@openai/codex-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { CodexRunRequest } from "../../../src/infrastructure/codex/codex-runtime.js";
import {
  CodexSdkRuntime,
  type SdkClientLike,
  type SdkThreadLike,
} from "../../../src/infrastructure/codex/codex-sdk-runtime.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true })),
  );
});

describe("CodexSdkRuntime", () => {
  it("streams, records, normalizes usage, and validates structured output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cxo-sdk-"));
    temporaryDirectories.push(directory);
    const seenOptions: ThreadOptions[] = [];
    const seenCodexOptions: CodexOptions[] = [];
    const thread = fakeThread("thread-1", [
      { type: "thread.started", thread_id: "thread-1" },
      {
        type: "item.completed",
        item: { id: "reasoning-1", type: "reasoning", text: "private reasoning SECRET=hidden" },
      },
      {
        type: "item.completed",
        item: { id: "message-1", type: "agent_message", text: '{"answer":"ok"}' },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 100,
          cached_input_tokens: 20,
          cache_write_input_tokens: 5,
          output_tokens: 30,
          reasoning_output_tokens: 10,
        },
      },
    ]);
    const runtime = new CodexSdkRuntime({
      environment: { PATH: "/usr/bin", HOME: "/tmp/home", API_TOKEN: "secret" },
      clientFactory: (options) => {
        seenCodexOptions.push(options);
        return clientFor(thread, seenOptions);
      },
    });
    const request = makeRequest(directory, "deepest");

    const result = await runtime.runStructured(request);

    expect(result).toMatchObject({
      threadId: "thread-1",
      output: { answer: "ok" },
      usage: { inputTokens: 100, outputTokens: 30, totalTokens: 130, source: "actual" },
      runtimeAttempts: 1,
      compatibility: { mappedReasoning: "xhigh", fallbackApplied: false },
    });
    expect(seenOptions[0]).toMatchObject({
      model: "gpt-5.6",
      modelReasoningEffort: "xhigh",
      sandboxMode: "read-only",
      skipGitRepoCheck: false,
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      approvalPolicy: "never",
      additionalDirectories: [],
    });
    expect(seenCodexOptions[0]?.env).toEqual({ HOME: "/tmp/home", PATH: "/usr/bin" });
    const events = await readFile(request.eventsPath, "utf8");
    expect(events).not.toContain("private reasoning");
    expect(events).not.toContain("hidden");
    expect(events).toContain("runtime.compatibility");
  });

  it("uses one controlled fallback only for an explicit effort compatibility failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cxo-sdk-"));
    temporaryDirectories.push(directory);
    const seenOptions: ThreadOptions[] = [];
    let starts = 0;
    const runtime = new CodexSdkRuntime({
      clientFactory: () => ({
        startThread: (options) => {
          if (options !== undefined) seenOptions.push(options);
          starts += 1;
          return starts === 1
            ? fakeThread(null, [
                {
                  type: "turn.failed",
                  error: { message: "reasoning effort xhigh is not supported by this model" },
                },
              ])
            : fakeThread("thread-2", [
                { type: "thread.started", thread_id: "thread-2" },
                {
                  type: "item.completed",
                  item: { id: "message-2", type: "agent_message", text: '{"answer":"fallback"}' },
                },
                {
                  type: "turn.completed",
                  usage: {
                    input_tokens: 1,
                    cached_input_tokens: 0,
                    cache_write_input_tokens: 0,
                    output_tokens: 1,
                    reasoning_output_tokens: 0,
                  },
                },
              ]);
        },
        resumeThread: () => {
          throw new Error("unexpected resume");
        },
      }),
    });

    const result = await runtime.runStructured(makeRequest(directory, "deepest"));

    expect(starts).toBe(2);
    expect(seenOptions.map((options) => options.modelReasoningEffort)).toEqual(["xhigh", "high"]);
    expect(result.runtimeAttempts).toBe(2);
    expect(result.compatibility).toMatchObject({ fallbackApplied: true, mappedReasoning: "high" });
  });

  it("performs one isolated low-cost repair for invalid structured output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cxo-sdk-"));
    temporaryDirectories.push(directory);
    const prompts: string[] = [];
    const options: ThreadOptions[] = [];
    let starts = 0;
    const runtime = new CodexSdkRuntime({
      clientFactory: () => ({
        startThread: (threadOptions) => {
          if (threadOptions !== undefined) options.push(threadOptions);
          starts += 1;
          const response = starts === 1 ? '{"answer":1}' : '{"answer":"repaired"}';
          const thread = fakeThread(`repair-${starts}`, [
            { type: "thread.started", thread_id: `repair-${starts}` },
            {
              type: "item.completed",
              item: { id: `message-${starts}`, type: "agent_message", text: response },
            },
            {
              type: "turn.completed",
              usage: {
                input_tokens: 5,
                cached_input_tokens: 0,
                cache_write_input_tokens: 0,
                output_tokens: 2,
                reasoning_output_tokens: 0,
              },
            },
          ]);
          return {
            ...thread,
            runStreamed: async (input, turnOptions) => {
              prompts.push(input);
              return thread.runStreamed(input, turnOptions);
            },
          };
        },
        resumeThread: () => {
          throw new Error("repair must use a fresh thread");
        },
      }),
    });

    const result = await runtime.runStructured(makeRequest(directory, "high"));

    expect(result).toMatchObject({
      threadId: "repair-2",
      output: { answer: "repaired" },
      runtimeAttempts: 2,
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
    });
    expect(options.map((item) => item.modelReasoningEffort)).toEqual(["high", "minimal"]);
    expect(prompts[1]).toContain('{"answer":1}');
    expect(prompts[1]).not.toContain("Return structured output");
    expect(await readFile(makeRequest(directory, "high").eventsPath, "utf8")).toContain(
      "runtime.output_repair",
    );
  });

  it("honors explicit cancellation before starting an SDK thread", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cxo-sdk-"));
    temporaryDirectories.push(directory);
    const controller = new AbortController();
    controller.abort(new Error("user cancelled"));
    let starts = 0;
    const runtime = new CodexSdkRuntime({
      clientFactory: () => ({
        startThread: () => {
          starts += 1;
          return fakeThread("unexpected", []);
        },
        resumeThread: () => fakeThread("unexpected", []),
      }),
    });

    await expect(
      runtime.runStructured({
        ...makeRequest(directory, "medium"),
        abortSignal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "CANCELLED", resumable: true });
    expect(starts).toBe(0);
  });

  it("aborts an SDK call when its timeout expires", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cxo-sdk-"));
    temporaryDirectories.push(directory);
    const hanging: SdkThreadLike = {
      id: null,
      runStreamed: async (input, options) => {
        const signal = options?.signal;
        if (signal === undefined) throw new Error(`missing abort signal for ${input.length} bytes`);
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
        throw signal.reason;
      },
    };
    const runtime = new CodexSdkRuntime({ clientFactory: () => clientFor(hanging, []) });

    await expect(
      runtime.runStructured({ ...makeRequest(directory, "low"), timeoutMs: 10 }),
    ).rejects.toThrow("timed out");
  });
});

function makeRequest(
  directory: string,
  reasoningPreset: CodexRunRequest<{ answer: string }>["reasoningPreset"],
): CodexRunRequest<{ answer: string }> {
  return {
    role: "diagnostician",
    prompt: "Return structured output",
    workingDirectory: directory,
    model: "gpt-5.6",
    reasoningPreset,
    sandboxMode: "read-only",
    approvalPolicy: "never",
    networkAccessEnabled: false,
    outputSchema: {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
      additionalProperties: false,
    },
    outputValidator: z.object({ answer: z.string() }).strict(),
    timeoutMs: 5_000,
    eventsPath: join(directory, "events.jsonl"),
  };
}

function clientFor(thread: SdkThreadLike, seenOptions: ThreadOptions[]): SdkClientLike {
  return {
    startThread: (options) => {
      if (options !== undefined) seenOptions.push(options);
      return thread;
    },
    resumeThread: () => thread,
  };
}

function fakeThread(id: string | null, sourceEvents: readonly ThreadEvent[]): SdkThreadLike {
  return {
    id,
    runStreamed: () =>
      Promise.resolve({
        events: (async function* events(): AsyncGenerator<ThreadEvent> {
          for (const event of sourceEvents) {
            await Promise.resolve();
            yield event;
          }
        })(),
      }),
  };
}
