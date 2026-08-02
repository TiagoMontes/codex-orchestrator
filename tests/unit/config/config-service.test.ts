import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigService } from "../../../src/application/configuration/config-service.js";
import { StatePaths } from "../../../src/infrastructure/persistence/state-paths.js";
import { OrchestratorError } from "../../../src/shared/errors.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true })),
  );
});

async function createService(): Promise<{ service: ConfigService; home: string }> {
  const home = await mkdtemp(join(tmpdir(), "cxo-config-"));
  temporaryDirectories.push(home);
  return {
    home,
    service: new ConfigService(new StatePaths({ CODEX_ORCHESTRATOR_HOME: home })),
  };
}

describe("ConfigService", () => {
  it("initializes and validates a default config under an isolated home", async () => {
    const { service, home } = await createService();

    const initialized = await service.initialize();
    const loaded = await service.load();

    expect(initialized.path).toBe(join(home, "config.yaml"));
    expect(loaded.defaultProfile).toBe("balanced");
    expect(loaded.models.aliases.capable).toBe("gpt-5.6");
    expect(await service.validate()).toMatchObject({ valid: true, schemaVersion: 1 });
    expect(await readFile(initialized.path, "utf8")).toContain("nativeCodexSubagents: false");
  });

  it("does not overwrite an existing config", async () => {
    const { service } = await createService();
    await service.initialize();

    await expect(service.initialize()).rejects.toMatchObject({
      code: "CONFIGURATION",
      nextCommand: "cxo config validate",
    });
  });

  it("reports invalid configuration as a typed error", async () => {
    const { service, home } = await createService();
    await writeFile(join(home, "config.yaml"), "schemaVersion: 99\n", "utf8");

    await expect(service.load()).rejects.toBeInstanceOf(OrchestratorError);
    await expect(service.load()).rejects.toMatchObject({ code: "CONFIGURATION" });
  });
});
