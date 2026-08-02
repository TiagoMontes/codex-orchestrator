import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { AtomicFileWriter } from "../../../src/infrastructure/persistence/atomic-file-writer.js";
import { AtomicJsonStore } from "../../../src/infrastructure/persistence/atomic-json-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true })),
  );
});

describe("AtomicJsonStore", () => {
  it("round-trips validated documents", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cxo-store-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "state.json");
    const store = new AtomicJsonStore();
    const schema = z.object({ schemaVersion: z.literal(1), value: z.string() }).strict();

    await store.write(path, { schemaVersion: 1, value: "durable" });

    await expect(store.read(path, schema)).resolves.toEqual({ schemaVersion: 1, value: "durable" });
  });

  it("leaves the prior document intact when interrupted before rename", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cxo-store-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "state.json");
    const initial = new AtomicJsonStore();
    await initial.write(path, { schemaVersion: 1, value: "prior" });
    const interrupted = new AtomicJsonStore(
      new AtomicFileWriter({
        beforeRename: () => Promise.reject(new Error("simulated interruption")),
      }),
    );

    await expect(interrupted.write(path, { schemaVersion: 1, value: "new" })).rejects.toThrow(
      "simulated interruption",
    );

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ schemaVersion: 1, value: "prior" });
  });
});
