import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigService } from "../../src/application/configuration/config-service.js";
import type { DoctorRunner } from "../../src/application/doctor/doctor-types.js";
import { createProgram } from "../../src/cli/program.js";
import type { OutputWriter } from "../../src/cli/output.js";
import type {
  AgentRole,
  CodexRunRequest,
  CodexRunResult,
  CodexRuntime,
} from "../../src/infrastructure/codex/codex-runtime.js";
import { DiffService } from "../../src/infrastructure/git/diff-service.js";
import { StatePaths } from "../../src/infrastructure/persistence/state-paths.js";
import { VerificationFileRepository } from "../../src/infrastructure/persistence/verification-file-repository.js";
import { verificationPolicyHash } from "../../src/application/tasks/verification-policy.js";
import { projectSchema } from "../../src/domain/project/project.js";

const temporaryDirectories: string[] = [];
const feedbackPath = join(process.cwd(), "tests", "fixtures", "feedback.md");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true })),
  );
});

describe("required fixture demonstration", () => {
  it("drives the complete CLI workflow while leaving the broken primary checkout untouched", async () => {
    const repositoryRoot = await realpath(await mkdtemp(join(tmpdir(), "cxo-demo-repo-")));
    const stateHome = await mkdtemp(join(tmpdir(), "cxo-demo-state-"));
    temporaryDirectories.push(repositoryRoot, stateHome);
    const sourceCommit = await createBrokenBetRepository(repositoryRoot);
    const originalPrimary = {
      head: sourceCommit,
      status: await git(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"]),
      service: await readFile(join(repositoryRoot, "src", "bet-service.js"), "utf8"),
    };
    expect((await runTests(repositoryRoot)).exitCode).toBe(1);

    const paths = new StatePaths({ CODEX_ORCHESTRATOR_HOME: stateHome });
    const configService = new ConfigService(paths);
    const requests: Array<{
      role: AgentRole;
      sandbox: string;
      workingDirectory: string;
      threadId: string;
    }> = [];
    let taskId = "";
    let callNumber = 0;
    const runtime: CodexRuntime = {
      async runStructured<T>(request: CodexRunRequest<T>): Promise<CodexRunResult<T>> {
        callNumber += 1;
        taskId ||= extractTaskId(request.prompt);
        const threadId = `${request.role}-thread-${callNumber}`;
        expect(request.resumeThreadId).toBeUndefined();
        requests.push({
          role: request.role,
          sandbox: request.sandboxMode,
          workingDirectory: request.workingDirectory,
          threadId,
        });
        await writeFakeEvents(request.eventsPath, threadId, request.role);
        const output = await fakeOutput(request, {
          projectId: "demo",
          sourceCommit,
          taskId,
          paths,
        });
        const validated = request.outputValidator.parse(output);
        return {
          threadId,
          output: validated,
          eventsPath: request.eventsPath,
          usage: {
            inputTokens: 400,
            cachedInputTokens: 20,
            cacheWriteInputTokens: 0,
            outputTokens: 100,
            reasoningOutputTokens: 20,
            totalTokens: 500,
            source: "actual",
          },
          finalResponse: JSON.stringify(validated),
          runtimeAttempts: 1,
          compatibility: {
            sdkVersion: "0.146.0",
            requestedReasoning: request.reasoningPreset,
            mappedReasoning:
              request.reasoningPreset === "deepest" ? "xhigh" : request.reasoningPreset,
            fallbackApplied: false,
            missingUsageFields: [],
          },
        };
      },
    };
    const doctor: DoctorRunner = {
      run: () =>
        Promise.resolve({
          schemaVersion: 1,
          overallStatus: "healthy",
          deep: false,
          modelCallPerformed: false,
          checks: [
            { name: "node", status: "pass", message: "fixture Node is available" },
            { name: "git", status: "pass", message: "fixture Git is available" },
          ],
        }),
    };
    const invoke = async (args: string[]): Promise<{ stdout: string[]; stderr: string[] }> => {
      const capture = captureOutput();
      const program = createProgram({
        output: capture.output,
        configService,
        doctorService: doctor,
        codexRuntime: runtime,
      });
      await program.parseAsync(["node", "cxo", ...args]);
      return capture;
    };

    expect(parseJson(await invoke(["--json", "config", "init"]))).toMatchObject({
      created: true,
    });
    expect((await invoke(["doctor"])).stdout.join("\n")).toContain("Doctor status: healthy");
    const project = parseJson(
      await invoke(["--json", "project", "add", repositoryRoot, "--name", "demo"]),
    );
    expect(project).toMatchObject({ id: "demo", gitRoot: repositoryRoot });
    const projectConfigPath = join(paths.projectDirectory("demo"), "project-config.yaml");
    const editedProjectConfig = `schemaVersion: 1
projectId: demo
verification:
  focused:
    - name: edited-bet-regression
      command: [node, --test, test/bet-service.test.js]
      timeoutSeconds: 90
      source: fixture-edited
      approved: true
  full: []
  candidates: []
`;
    await writeFile(projectConfigPath, editedProjectConfig, "utf8");
    const configuredProject = parseJson(await invoke(["--json", "project", "inspect", "demo"]));
    expect(configuredProject).toMatchObject({
      verificationPolicy: {
        focused: [
          {
            name: "edited-bet-regression",
            argv: ["node", "--test", "test/bet-service.test.js"],
            approved: true,
          },
        ],
      },
    });
    const refreshedProject = parseJson(await invoke(["--json", "project", "refresh", "demo"]));
    expect(refreshedProject).toMatchObject({
      project: { verificationPolicy: objectAt(configuredProject, "verificationPolicy") },
    });
    expect(await readFile(projectConfigPath, "utf8")).toBe(editedProjectConfig);
    const audit = parseJson(await invoke(["--json", "project", "audit", "demo"]));
    expect(audit).toMatchObject({ manifest: { sourceCommit, stale: false } });
    const created = parseJson(
      await invoke(["--json", "task", "create", "--project", "demo", "--from", feedbackPath]),
    );
    taskId = String(objectAt(created, "task").id);
    expect(taskId).toMatch(/^BUG-\d{4}-\d{4}$/u);
    expect(objectAt(created, "task")).toMatchObject({
      type: "bugfix",
      status: "ready-for-diagnosis",
      protectedContracts: ["contracts/bet-response.json"],
    });
    const diagnosis = parseJson(await invoke(["--json", "task", "diagnose", taskId]));
    expect(diagnosis).toMatchObject({
      diagnosis: { taskId, sourceCommit, status: "confirmed" },
    });
    const run = parseJson(await invoke(["--json", "task", "run", taskId]));
    expect(run).toMatchObject({
      task: { status: "reviewing" },
      verification: {
        overallStatus: "passed",
        sourceCommit,
        commands: [
          {
            name: "edited-bet-regression",
            argv: ["node", "--test", "test/bet-service.test.js"],
          },
        ],
      },
    });
    expect(objectAt(run, "verification").policyHash).toBe(
      verificationPolicyHash(projectSchema.parse(configuredProject)),
    );
    const review = parseJson(await invoke(["--json", "task", "review", taskId]));
    expect(review).toMatchObject({
      task: { status: "completed" },
      finalReport: {
        task: { id: taskId, status: "completed" },
        state: { status: "completed" },
        artifacts: {
          diagnosis: { status: "confirmed" },
          diff: { changedFiles: ["src/bet-service.js"] },
          verification: { overallStatus: "passed" },
          review: { verdict: "approve" },
        },
        integrity: { artifactRelationshipsValid: true, liveDiffCurrent: true },
      },
    });
    const inspected = parseJson(await invoke(["--json", "task", "inspect", taskId]));
    expect(inspected).toMatchObject({ id: taskId, status: "completed" });
    const diff = parseJson(await invoke(["--json", "task", "diff", taskId, "--patch"]));
    expect(diff).toMatchObject({ taskId, live: true, verified: true });
    expect(String(diff.patch)).toContain("too_many_guesses");
    const status = parseJson(await invoke(["task", "status", taskId, "--json"]));
    expect(status).toMatchObject({
      state: { status: "completed" },
      integrity: { artifactRelationshipsValid: true, liveDiffCurrent: true },
    });
    expect(arrayAt(status, "usageBreakdown").map((item) => stringAt(item, "phase"))).toEqual(
      expect.arrayContaining(["normalization", "diagnosis", "implementation", "review"]),
    );
    const logs = parseJson(await invoke(["--json", "task", "logs", taskId, "--tail", "20"]));
    expect(arrayAt(logs, "records").length).toBeGreaterThan(0);

    const finalTask = objectAt(review, "task");
    const worktree = objectAt(finalTask, "worktree");
    const worktreePath = String(worktree.path);
    const feedback = await readFile(feedbackPath);
    expect(
      await readFile(join(paths.taskDirectory("demo", taskId), "original-feedback.md")),
    ).toEqual(feedback);
    expect(await runTests(worktreePath)).toMatchObject({ exitCode: 0 });
    expect(await runTests(repositoryRoot)).toMatchObject({ exitCode: 1 });
    expect(await readFile(join(worktreePath, "src", "bet-service.js"), "utf8")).toContain(
      'status: 422, body: { error: "too_many_guesses" }',
    );
    expect(await git(worktreePath, ["status", "--porcelain=v1"])).not.toBe("");
    expect(await git(repositoryRoot, ["rev-parse", "HEAD"])).toBe(originalPrimary.head);
    expect(await git(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe(
      originalPrimary.status,
    );
    expect(await readFile(join(repositoryRoot, "src", "bet-service.js"), "utf8")).toBe(
      originalPrimary.service,
    );
    expect(await git(repositoryRoot, ["rev-list", "--count", "HEAD"])).toBe("2");
    expect(await git(repositoryRoot, ["rev-parse", String(worktree.branch)])).toBe(sourceCommit);
    expect(await git(repositoryRoot, ["remote"])).toBe("");

    expect(requests.map((request) => request.role)).toEqual([
      "audit-mapper",
      "normalizer",
      "diagnostician",
      "implementer",
      "reviewer",
    ]);
    expect(requests.map((request) => request.threadId).length).toBe(
      new Set(requests.map((request) => request.threadId)).size,
    );
    const diagnosisRequest = requests.find((request) => request.role === "diagnostician");
    expect(diagnosisRequest).toMatchObject({ sandbox: "read-only" });
    expect(diagnosisRequest?.workingDirectory).not.toBe(repositoryRoot);
    expect(diagnosisRequest?.workingDirectory).toContain(`${taskId}-diagnosis-`);
    expect(requests.find((request) => request.role === "implementer")).toMatchObject({
      sandbox: "workspace-write",
      workingDirectory: worktreePath,
    });
    expect(requests.find((request) => request.role === "reviewer")).toMatchObject({
      sandbox: "read-only",
      workingDirectory: worktreePath,
    });
  }, 30_000);
});

async function fakeOutput<T>(
  request: CodexRunRequest<T>,
  context: { projectId: string; sourceCommit: string; taskId: string; paths: StatePaths },
): Promise<unknown> {
  if (request.role === "normalizer") return normalizedDraft();
  if (request.role === "audit-mapper") return auditOutput(context.projectId, context.sourceCommit);
  if (request.role === "diagnostician")
    return diagnosisOutput(context.taskId, context.sourceCommit);
  if (request.role === "implementer" || request.role === "corrector") {
    await writeFile(join(request.workingDirectory, "src", "bet-service.js"), FIXED_SERVICE, "utf8");
    return {
      schemaVersion: 1,
      taskId: context.taskId,
      status: "changed",
      summary: "Restored the quantity validation response without changing the contract",
      advisoryChangedFiles: ["src/bet-service.js"],
      testsAddedOrUpdated: [],
      unresolvedRisks: [],
      completedAt: "2026-08-02T12:04:00.000Z",
    };
  }
  if (request.role === "reviewer") {
    const diff = await new DiffService(context.paths).read(context.projectId, context.taskId);
    const verification = await new VerificationFileRepository(context.paths).read(
      context.projectId,
      context.taskId,
    );
    const evidenceId = verification.commands[0]?.evidenceId ?? "E1";
    return {
      schemaVersion: 1,
      taskId: context.taskId,
      sourceCommit: context.sourceCommit,
      reviewedDiffHash: diff.diffHash,
      verdict: "approve",
      findings: [],
      acceptanceCriteriaAssessment: ["AC-1", "AC-2", "AC-3"].map((criterionId) => ({
        criterionId,
        status: "met",
        evidenceIds: [evidenceId],
        explanation: "The exact diff and passing Node regression suite satisfy this criterion.",
      })),
      scopeAssessment: {
        withinScope: true,
        unexpectedFiles: [],
        explanation: "Only the diagnosed bet service changed.",
      },
      createdAt: "2026-08-02T12:05:00.000Z",
    };
  }
  throw new Error(`Unexpected fake runtime role: ${request.role}`);
}

function normalizedDraft(): unknown {
  return {
    type: "bugfix",
    title: "Restore bet quantity validation",
    summary: "POST /bet returns 500 instead of 422 for more than ten guesses.",
    reports: [
      {
        id: "R1",
        title: "POST /bet quantity guard regression",
        route: "/bet",
        method: "POST",
        currentBehavior: "More than ten guesses produces HTTP 500 with internal_error.",
        expectedBehavior: [
          "Valid payloads return HTTP 201.",
          "More than ten guesses returns HTTP 422 with too_many_guesses.",
        ],
        payloads: [],
        observedResponses: [{ status: 500, body: { error: "internal_error" } }],
        errorMessages: ["internal_error"],
        stackTraces: [],
        environment: {},
        suspectedChanges: ["src/bet-service.js quantity guard"],
        reproductionNotes: [],
      },
    ],
    constraints: ["Do not modify migrations.", "Add or retain regression coverage."],
    acceptanceCriteria: [
      { id: "AC-1", statement: "Valid payloads return HTTP 201.", required: true, source: "user" },
      {
        id: "AC-2",
        statement: "More than ten guesses returns HTTP 422 with too_many_guesses.",
        required: true,
        source: "user",
      },
      {
        id: "AC-3",
        statement: "The public response contract remains unchanged.",
        required: true,
        source: "user",
      },
    ],
    protectedContracts: ["contracts/bet-response.json"],
    assumptions: [
      {
        statement: "The quantity guard may have regressed.",
        provenance: "user-hypothesis",
        status: "unverified",
      },
    ],
    unknowns: [],
    riskSignals: ["public API contract", "HTTP response semantics"],
    suggestedScope: {
      included: ["src/bet-service.js", "test/bet-service.test.js"],
      excluded: ["migrations"],
      estimatedFiles: ["src/bet-service.js", "test/bet-service.test.js"],
    },
    childTasks: [],
  };
}

function diagnosisOutput(taskId: string, sourceCommit: string): unknown {
  return {
    diagnosis: {
      schemaVersion: 1,
      taskId,
      sourceCommit,
      status: "confirmed",
      reproduction: {
        attempted: true,
        reproduced: true,
        steps: ["Run node --test at the regression commit"],
        blockers: [],
        evidenceIds: ["E1"],
      },
      confirmedFacts: [
        {
          statement: "The quantity guard returns 500 for more than ten guesses.",
          evidenceIds: ["E1"],
        },
      ],
      rootCauses: [
        {
          statement: "The guard maps a validation case to the internal-error response.",
          confidence: "high",
          evidenceIds: ["E1"],
        },
      ],
      activeHypotheses: [],
      rejectedHypotheses: [],
      affectedFiles: [
        {
          path: "src/bet-service.js",
          reason: "Contains the regressed quantity guard",
          symbols: ["createBet"],
        },
      ],
      risks: ["Preserve contracts/bet-response.json and valid HTTP 201 behavior"],
      implementationPlan: [
        {
          id: "P1",
          description: "Restore the 422 quantity response without changing other responses",
          files: ["src/bet-service.js"],
          risk: "medium",
        },
      ],
      verificationPlan: [
        {
          id: "V1",
          name: "Node regression suite",
          argv: ["node", "--test"],
          expectedOutcome: "all tests pass",
        },
      ],
      nextAction: "Implement the focused guard fix in an isolated worktree",
      createdAt: "2026-08-02T12:03:00.000Z",
    },
    evidence: [
      {
        id: "E1",
        taskId,
        kind: "file",
        status: "confirmed",
        statement: "The quantity guard returns the internal-error response.",
        sourceCommit,
        file: "src/bet-service.js",
        startLine: 5,
        endLine: 7,
        observedAt: "2026-08-02T12:03:00.000Z",
      },
    ],
  };
}

function auditOutput(projectId: string, sourceCommit: string): unknown {
  const evidenceReferences = [
    {
      id: "K1",
      kind: "file",
      status: "confirmed",
      statement: "The bet service contains the POST /bet domain behavior.",
      sourceCommit,
      file: "src/bet-service.js",
      startLine: 1,
      endLine: 7,
    },
    {
      id: "K2",
      kind: "file",
      status: "confirmed",
      statement: "The package declares node --test.",
      sourceCommit,
      file: "package.json",
      startLine: 1,
      endLine: 1,
    },
  ];
  return {
    schemaVersion: 1,
    projectId,
    sourceCommit,
    repositoryMap: {
      summary: "A small bet service with a protected response contract and Node tests.",
      modules: [
        {
          id: "M1",
          path: "src/bet-service.js",
          description: "Bet creation and quantity validation",
          evidenceIds: ["K1"],
          unknowns: [],
        },
      ],
      entryPoints: [
        {
          id: "EP1",
          path: "src/bet-service.js",
          description: "createBet service entry point",
          evidenceIds: ["K1"],
          unknowns: [],
        },
      ],
      unknowns: [],
    },
    architecture: {
      summary: "A pure service function protected by contract-focused tests.",
      components: [
        {
          id: "C1",
          name: "bet-service",
          responsibility: "Validate and create bets",
          paths: ["src/bet-service.js"],
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
          domain: "betting",
          statement: "A bet with more than ten guesses is rejected with HTTP 422.",
          confidence: "high",
          evidenceIds: ["K1"],
          relatedRoutes: ["POST /bet"],
          relatedSymbols: ["createBet"],
          exceptions: [],
          unknowns: [],
        },
      ],
      unknowns: [],
    },
    verification: {
      summary: "Node's built-in test runner protects the service contract.",
      strategies: [
        {
          id: "VS-1",
          name: "Node tests",
          kind: "test",
          command: "node --test",
          statement: "package.json declares node --test.",
          evidenceIds: ["K2"],
          unknowns: [],
        },
      ],
      unknowns: [],
    },
    risks: {
      summary: "HTTP status and response-body fields are public compatibility boundaries.",
      risks: [
        {
          id: "RK-1",
          statement: "Changing response fields can break route consumers.",
          severity: "high",
          affectedPaths: ["src/bet-service.js", "contracts/bet-response.json"],
          evidenceIds: ["K1"],
          unknowns: [],
        },
      ],
      unknowns: [],
    },
    evidenceReferences,
  };
}

async function createBrokenBetRepository(root: string): Promise<string> {
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "test"), { recursive: true });
  await mkdir(join(root, "contracts"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({ name: "bet-fixture", version: "1.0.0", type: "module", scripts: { test: "node --test" } }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(root, "AGENTS.md"),
    "# Fixture instructions\n\nPreserve the public response contract. Do not edit contracts or migrations.\n",
    "utf8",
  );
  await writeFile(
    join(root, "contracts", "bet-response.json"),
    '{"created":{"status":201,"fields":["id","guessCount"]},"invalid":{"status":422,"fields":["error"]}}\n',
    "utf8",
  );
  await writeFile(join(root, "src", "bet-service.js"), BASELINE_SERVICE, "utf8");
  await writeFile(join(root, "test", "bet-service.test.js"), BASELINE_TEST, "utf8");
  await git(root, ["init", "--initial-branch=main"]);
  await git(root, ["config", "user.email", "fixture@example.test"]);
  await git(root, ["config", "user.name", "Fixture"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "feat: add working bet contract"]);
  await writeFile(join(root, "src", "bet-service.js"), REGRESSED_SERVICE, "utf8");
  await writeFile(join(root, "test", "bet-service.test.js"), REGRESSION_TEST, "utf8");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "regression: break quantity validation"]);
  return git(root, ["rev-parse", "HEAD"]);
}

async function writeFakeEvents(path: string, threadId: string, role: AgentRole): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({ schemaVersion: 1, observedAt: "2026-08-02T12:00:00.000Z", type: "thread.started", payload: { thread_id: threadId, role } })}\n`,
    "utf8",
  );
}

function extractTaskId(prompt: string): string {
  return /(?:Task identity|Task):\s*(BUG-\d{4}-\d{4})/u.exec(prompt)?.[1] ?? "";
}

function captureOutput(): { output: OutputWriter; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    output: {
      write: (message) => stdout.push(message),
      writeError: (message) => stderr.push(message),
    },
  };
}

function parseJson(capture: { stdout: string[]; stderr: string[] }): Record<string, unknown> {
  expect(capture.stderr).toEqual([]);
  expect(capture.stdout).toHaveLength(1);
  return JSON.parse(capture.stdout[0] ?? "") as Record<string, unknown>;
}

function objectAt(value: unknown, key: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected object containing ${key}`);
  }
  const child = (value as Record<string, unknown>)[key];
  if (typeof child !== "object" || child === null || Array.isArray(child)) {
    throw new Error(`Expected object at ${key}`);
  }
  return child as Record<string, unknown>;
}

function arrayAt(value: unknown, key: string): unknown[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected object containing ${key}`);
  }
  const child = (value as Record<string, unknown>)[key];
  if (!Array.isArray(child)) throw new Error(`Expected array at ${key}`);
  return child;
}

function stringAt(value: unknown, key: string): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected object containing ${key}`);
  }
  const child = (value as Record<string, unknown>)[key];
  if (typeof child !== "string") throw new Error(`Expected string at ${key}`);
  return child;
}

async function git(root: string, argv: string[]): Promise<string> {
  return (await execa("git", ["-C", root, ...argv])).stdout;
}

async function runTests(root: string): Promise<{ exitCode: number }> {
  const result = await execa("node", ["--test"], { cwd: root, reject: false });
  return { exitCode: result.exitCode ?? 1 };
}

const BASELINE_SERVICE = `export function createBet(guesses) {
  if (!Array.isArray(guesses)) {
    return { status: 422, body: { error: "invalid_guesses" } };
  }
  return { status: 201, body: { id: "bet-1", guessCount: guesses.length } };
}
`;

const REGRESSED_SERVICE = `export function createBet(guesses) {
  if (!Array.isArray(guesses)) {
    return { status: 422, body: { error: "invalid_guesses" } };
  }
  if (guesses.length > 10) {
    return { status: 500, body: { error: "internal_error" } };
  }
  return { status: 201, body: { id: "bet-1", guessCount: guesses.length } };
}
`;

const FIXED_SERVICE = `export function createBet(guesses) {
  if (!Array.isArray(guesses)) {
    return { status: 422, body: { error: "invalid_guesses" } };
  }
  if (guesses.length > 10) {
    return { status: 422, body: { error: "too_many_guesses" } };
  }
  return { status: 201, body: { id: "bet-1", guessCount: guesses.length } };
}
`;

const BASELINE_TEST = `import test from "node:test";
import assert from "node:assert/strict";
import { createBet } from "../src/bet-service.js";

test("creates a valid bet without changing the public response", () => {
  assert.deepEqual(createBet([{ position: 1 }]), {
    status: 201,
    body: { id: "bet-1", guessCount: 1 },
  });
});
`;

const REGRESSION_TEST = `${BASELINE_TEST}
test("rejects more than ten guesses with the protected validation response", () => {
  assert.deepEqual(createBet(Array.from({ length: 11 }, (_, position) => ({ position }))), {
    status: 422,
    body: { error: "too_many_guesses" },
  });
});
`;
