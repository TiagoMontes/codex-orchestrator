import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectAuditService } from "../../src/application/auditing/project-audit-service.js";
import { ProjectRefreshService } from "../../src/application/auditing/project-refresh-service.js";
import { ConfigService } from "../../src/application/configuration/config-service.js";
import { ProjectService } from "../../src/application/projects/project-service.js";
import type {
  CodexRunRequest,
  CodexRunResult,
  CodexRuntime,
} from "../../src/infrastructure/codex/codex-runtime.js";
import { AuditArtifactRepository } from "../../src/infrastructure/persistence/audit-artifact-repository.js";
import { ProjectFileRepository } from "../../src/infrastructure/persistence/project-file-repository.js";
import { StatePaths } from "../../src/infrastructure/persistence/state-paths.js";
import { createGitFixture, gitOutput } from "../helpers/git-fixture.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true })),
  );
});

describe("project audit", () => {
  it("persists five evidenced commit-scoped artifacts and invalidates changed selected skills", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "cxo-audit-fixture-"));
    const stateHome = await mkdtemp(join(tmpdir(), "cxo-audit-state-"));
    temporaryDirectories.push(repositoryRoot, stateHome);
    await createGitFixture(repositoryRoot);
    const projectSkillPath = join(repositoryRoot, ".agents", "skills", "fixture-skill", "SKILL.md");
    await writeFile(
      projectSkillPath,
      "---\nname: fixture-skill\ndescription: Inspect the fixture.\ntags: [audit]\n---\n\nRead only.\n",
      "utf8",
    );
    await gitOutput(repositoryRoot, ["add", ".agents/skills/fixture-skill/SKILL.md"]);
    await gitOutput(repositoryRoot, ["commit", "-m", "test: select audit skill"]);
    const paths = new StatePaths({ CODEX_ORCHESTRATOR_HOME: stateHome });
    const config = new ConfigService(paths);
    await config.initialize();
    const projectRepository = new ProjectFileRepository(paths);
    const projects = new ProjectService(projectRepository);
    const project = await projects.add({ path: repositoryRoot, name: "demo" });
    const repository = new AuditArtifactRepository(paths);
    const refresher = new ProjectRefreshService(projects, projectRepository, repository);
    const sourceCommit = await gitOutput(repositoryRoot, ["rev-parse", "HEAD"]);
    const beforeStatus = await gitOutput(repositoryRoot, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    const requests: Array<CodexRunRequest<unknown>> = [];
    const runtime: CodexRuntime = {
      runStructured<T>(request: CodexRunRequest<T>): Promise<CodexRunResult<T>> {
        requests.push(request);
        const evidenceReferences = [
          {
            id: "K1",
            kind: "file",
            status: "confirmed",
            statement: "index.js exports publicValue",
            sourceCommit,
            file: "index.js",
            startLine: 1,
            endLine: 1,
          },
          {
            id: "K2",
            kind: "file",
            status: "confirmed",
            statement: "package.json defines the test script",
            sourceCommit,
            file: "package.json",
            startLine: 1,
            endLine: 12,
          },
        ];
        const output = request.outputValidator.parse({
          schemaVersion: 1,
          projectId: project.id,
          sourceCommit,
          repositoryMap: {
            summary: "A small ESM package with one public module and one test module",
            modules: [
              {
                id: "M1",
                path: "index.js",
                description: "Public value module",
                evidenceIds: ["K1"],
                unknowns: [],
              },
            ],
            entryPoints: [
              {
                id: "EP1",
                path: "index.js",
                description: "Package entry point",
                evidenceIds: ["K1"],
                unknowns: [],
              },
            ],
            unknowns: [],
          },
          architecture: {
            summary: "A single public module protected by Node tests",
            components: [
              {
                id: "C1",
                name: "public-value",
                responsibility: "Expose the publicValue contract",
                paths: ["index.js"],
                evidenceIds: ["K1"],
                unknowns: [],
              },
            ],
            relationships: [],
            unknowns: [],
          },
          businessRules: {
            rules: [
              {
                id: "BR-1",
                domain: "public-api",
                statement: "Consumers receive publicValue through the named export",
                confidence: "high",
                evidenceIds: ["K1"],
                relatedRoutes: [],
                relatedSymbols: ["publicValue"],
                exceptions: [],
                unknowns: [],
              },
            ],
            unknowns: [],
          },
          verification: {
            summary: "The package uses Node's built-in test runner",
            strategies: [
              {
                id: "VS-1",
                name: "Node tests",
                kind: "test",
                command: "node --test",
                statement: "The configured test script invokes node --test",
                evidenceIds: ["K2"],
                unknowns: [],
              },
            ],
            unknowns: [],
          },
          risks: {
            summary: "The public export is a compatibility boundary",
            risks: [
              {
                id: "R1",
                statement: "Changing the named export can break consumers",
                severity: "medium",
                affectedPaths: ["index.js"],
                evidenceIds: ["K1"],
                unknowns: [],
              },
            ],
            unknowns: [],
          },
          evidenceReferences,
        });
        return Promise.resolve({
          threadId: "audit-thread",
          output,
          eventsPath: request.eventsPath,
          usage: {
            inputTokens: 500,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            outputTokens: 250,
            reasoningOutputTokens: 50,
            totalTokens: 750,
            source: "actual",
          },
          finalResponse: JSON.stringify(output),
          runtimeAttempts: 1,
          compatibility: {
            sdkVersion: "0.146.0",
            requestedReasoning: request.reasoningPreset,
            mappedReasoning:
              request.reasoningPreset === "deepest" ? "xhigh" : request.reasoningPreset,
            fallbackApplied: false,
            missingUsageFields: [],
          },
        });
      },
    };
    const auditor = new ProjectAuditService(config, paths, refresher, runtime, repository, {
      now: () => new Date("2026-08-02T12:03:00.000Z"),
    });

    const report = await auditor.audit(project.id, { profile: "quality" });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      role: "audit-mapper",
      sandboxMode: "read-only",
      networkAccessEnabled: false,
      workingDirectory: project.gitRoot,
    });
    expect(requests[0]?.resumeThreadId).toBeUndefined();
    expect(report.manifest).toMatchObject({ sourceCommit, stale: false });
    expect(report.manifest.selectedSkills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "fixture-skill", source: "project" }),
      ]),
    );
    const auditRun = JSON.parse(
      await readFile(
        join(
          paths.knowledgeDirectory(project.id),
          "audit-runs",
          report.manifest.auditRunId,
          "run.json",
        ),
        "utf8",
      ),
    ) as { selectedSkills: Array<{ name: string; source: string }> };
    expect(
      auditRun.selectedSkills.some(
        (skill) => skill.name === "fixture-skill" && skill.source === "project",
      ),
    ).toBe(true);
    expect(report.artifacts.businessRules.payload.rules[0]).toMatchObject({ id: "BR-1" });
    expect(report.artifacts.repositoryMap.evidenceReferences[0]?.sha256).toMatch(/^[a-f0-9]{64}$/u);
    for (const filename of [
      "repository-map.json",
      "architecture.json",
      "business-rules.json",
      "verification.json",
      "risks.json",
      "manifest.json",
    ]) {
      await expect(
        access(join(paths.knowledgeDirectory(project.id), filename)),
      ).resolves.toBeUndefined();
    }
    expect(await gitOutput(repositoryRoot, ["rev-parse", "HEAD"])).toBe(sourceCommit);
    expect(
      await gitOutput(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"]),
    ).toBe(beforeStatus);

    await writeFile(
      projectSkillPath,
      "---\nname: fixture-skill\ndescription: Inspect the fixture.\ntags: [audit]\n---\n\nRead only and report unknowns.\n",
      "utf8",
    );
    await gitOutput(repositoryRoot, ["add", ".agents/skills/fixture-skill/SKILL.md"]);
    await gitOutput(repositoryRoot, ["commit", "-m", "test: change selected audit skill"]);
    const nextCommit = await gitOutput(repositoryRoot, ["rev-parse", "HEAD"]);
    const refresh = await refresher.refresh(project.id);

    expect(refresh.project.registeredHeadCommit).toBe(sourceCommit);
    expect(refresh.project.currentHeadCommit).toBe(nextCommit);
    expect(refresh.freshness).toMatchObject({
      stale: true,
      usable: false,
      reason: "Selected workflow skills changed after the audit",
    });
    expect(refresh.knowledge?.manifest.stale).toBe(true);
    expect(
      Object.values(refresh.knowledge?.artifacts ?? {}).every((artifact) => artifact.stale),
    ).toBe(true);
    const persistedManifest = JSON.parse(
      await readFile(join(paths.knowledgeDirectory(project.id), "manifest.json"), "utf8"),
    ) as { currentHeadCommit: string; stale: boolean; selectedSkills: Array<{ sha256: string }> };
    expect(persistedManifest).toMatchObject({ currentHeadCommit: nextCommit, stale: true });
    expect(persistedManifest.selectedSkills).toEqual(report.manifest.selectedSkills);
  });
});
