import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectService } from "../../src/application/projects/project-service.js";
import { ProjectFileRepository } from "../../src/infrastructure/persistence/project-file-repository.js";
import { StatePaths } from "../../src/infrastructure/persistence/state-paths.js";
import { createGitFixture, gitOutput } from "../helpers/git-fixture.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true })),
  );
});

describe("project registration", () => {
  it("persists canonical metadata without changing the target repository", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "cxo-project-fixture-"));
    const stateHome = await mkdtemp(join(tmpdir(), "cxo-project-state-"));
    temporaryDirectories.push(fixture, stateHome);
    await createGitFixture(fixture);
    const beforeStatus = await gitOutput(fixture, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    const beforeHead = await gitOutput(fixture, ["rev-parse", "HEAD"]);
    const paths = new StatePaths({ CODEX_ORCHESTRATOR_HOME: stateHome });
    const service = new ProjectService(new ProjectFileRepository(paths));

    const project = await service.add({ path: join(fixture, "test", ".."), name: "demo" });

    expect(project.id).toBe("demo");
    expect(project.gitRoot).toBe(
      await import("node:fs/promises").then(({ realpath }) => realpath(fixture)),
    );
    expect(project.detectedStack).toMatchObject({
      languages: ["JavaScript/TypeScript"],
      frameworks: ["Express"],
    });
    expect(project.instructionFiles).toHaveLength(1);
    expect(project.skillMetadata[0]).toMatchObject({ name: "fixture-skill", source: "project" });
    expect(project.verificationPolicy.full[0]).toMatchObject({
      argv: ["node", "--test"],
      approved: true,
    });
    expect(JSON.stringify(project.remotes)).not.toMatch(/fixture-user|fixture-token|hidden/u);
    expect(await gitOutput(fixture, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe(
      beforeStatus,
    );
    expect(await gitOutput(fixture, ["rev-parse", "HEAD"])).toBe(beforeHead);
    expect(
      JSON.parse(await readFile(join(stateHome, "projects", "demo", "project.json"), "utf8")),
    ).toMatchObject({
      schemaVersion: 1,
      id: "demo",
    });
  });

  it("removes orchestrator state without deleting the target repository", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "cxo-project-fixture-"));
    const stateHome = await mkdtemp(join(tmpdir(), "cxo-project-state-"));
    temporaryDirectories.push(fixture, stateHome);
    await createGitFixture(fixture);
    const paths = new StatePaths({ CODEX_ORCHESTRATOR_HOME: stateHome });
    const service = new ProjectService(new ProjectFileRepository(paths));
    await service.add({ path: fixture, name: "demo" });

    await service.remove("demo");

    await expect(readFile(join(fixture, "package.json"), "utf8")).resolves.toContain(
      "fixture-project",
    );
    await expect(service.list()).resolves.toEqual([]);
  });
});
