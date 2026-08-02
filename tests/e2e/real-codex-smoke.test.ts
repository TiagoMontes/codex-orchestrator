import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { DEFAULT_CONFIG } from "../../src/application/configuration/default-config.js";
import { CodexSdkRuntime } from "../../src/infrastructure/codex/codex-sdk-runtime.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true })),
  );
});

describe("opt-in real Codex smoke", () => {
  it.skipIf(process.env.RUN_CODEX_E2E !== "1")(
    "performs one tiny read-only structured call in a temporary Git repository",
    async () => {
      const repositoryRoot = await mkdtemp(join(tmpdir(), "cxo-real-codex-"));
      temporaryDirectories.push(repositoryRoot);
      await writeFile(join(repositoryRoot, "README.txt"), "fixture-token: ORANGE\n", "utf8");
      await git(repositoryRoot, ["init", "--initial-branch=main"]);
      await git(repositoryRoot, ["config", "user.email", "fixture@example.test"]);
      await git(repositoryRoot, ["config", "user.name", "Fixture"]);
      await git(repositoryRoot, ["add", "README.txt"]);
      await git(repositoryRoot, ["commit", "-m", "test: add read-only fixture"]);
      const beforeHead = await git(repositoryRoot, ["rev-parse", "HEAD"]);
      const output = z.object({ token: z.literal("ORANGE") }).strict();

      const result = await new CodexSdkRuntime().runStructured({
        role: "repository-explorer",
        prompt: "Read README.txt and return only the fixture token in the required schema.",
        workingDirectory: repositoryRoot,
        model: process.env.CODEX_E2E_MODEL ?? DEFAULT_CONFIG.models.aliases.fast,
        reasoningPreset: "minimal",
        sandboxMode: "read-only",
        approvalPolicy: "never",
        networkAccessEnabled: false,
        outputSchema: z.toJSONSchema(output),
        outputValidator: output,
        timeoutMs: 120_000,
        eventsPath: join(repositoryRoot, ".git", "cxo-real-events.jsonl"),
      });

      expect(result.output).toEqual({ token: "ORANGE" });
      expect(await git(repositoryRoot, ["rev-parse", "HEAD"])).toBe(beforeHead);
      expect(await git(repositoryRoot, ["status", "--porcelain=v1"])).toBe("");
    },
    150_000,
  );
});

async function git(root: string, argv: string[]): Promise<string> {
  return (await execa("git", ["-C", root, ...argv])).stdout;
}
