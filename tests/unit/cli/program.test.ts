import { describe, expect, it } from "vitest";
import type { OutputWriter } from "../../../src/cli/output.js";
import { createProgram } from "../../../src/cli/program.js";
import { handleCliError } from "../../../src/cli/errors.js";
import { OrchestratorError } from "../../../src/shared/errors.js";

function createCapture(): { output: OutputWriter; stdout: string[]; stderr: string[] } {
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

describe("CLI program", () => {
  it("renders help under the cxo binary name", () => {
    const capture = createCapture();
    const program = createProgram({ output: capture.output });

    const help = program.helpInformation();

    expect(help).toContain("Usage: cxo [options]");
    expect(help).toContain("external Git repositories");
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr).toEqual([]);
  });

  it("registers the complete system, project, and task command contract", () => {
    const program = createProgram({ output: createCapture().output });
    const commands = new Map(program.commands.map((command) => [command.name(), command]));

    expect([...commands.keys()]).toEqual(["config", "doctor", "project", "task"]);
    expect(commands.get("config")?.commands.map((command) => command.name())).toEqual([
      "init",
      "show",
      "path",
      "validate",
    ]);
    expect(commands.get("project")?.commands.map((command) => command.name())).toEqual([
      "add",
      "list",
      "inspect",
      "remove",
      "audit",
      "refresh",
    ]);
    expect(commands.get("task")?.commands.map((command) => command.name())).toEqual([
      "create",
      "list",
      "inspect",
      "status",
      "diagnose",
      "run",
      "review",
      "diff",
      "logs",
      "resume",
      "cancel",
      "cleanup",
    ]);
  });

  it("emits one structured error object under JSON mode", () => {
    const capture = createCapture();
    const exitCode = handleCliError(
      new OrchestratorError("bad phase", {
        code: "CLI_INPUT",
        resumable: true,
        nextCommand: "cxo task status BUG-2026-0001",
      }),
      capture.output,
      { json: true },
    );

    expect(exitCode).toBe(2);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr).toHaveLength(1);
    expect(JSON.parse(capture.stderr[0] ?? "")).toEqual({
      ok: false,
      error: {
        code: "CLI_INPUT",
        message: "bad phase",
        exitCode: 2,
        resumable: true,
        nextCommand: "cxo task status BUG-2026-0001",
      },
    });
  });
});
