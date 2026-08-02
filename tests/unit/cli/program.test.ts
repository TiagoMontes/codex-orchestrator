import { describe, expect, it } from "vitest";
import type { OutputWriter } from "../../../src/cli/output.js";
import { createProgram } from "../../../src/cli/program.js";

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
});
