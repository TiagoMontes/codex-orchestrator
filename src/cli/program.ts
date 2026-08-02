import { Command } from "commander";
import type { CommanderError } from "commander";
import type { OutputWriter } from "./output.js";
import { consoleOutput } from "./output.js";
import { OrchestratorError } from "../shared/errors.js";

export type ProgramDependencies = {
  output?: OutputWriter;
};

export function createProgram(dependencies: ProgramDependencies = {}): Command {
  const output = dependencies.output ?? consoleOutput;
  const program = new Command();

  program
    .name("cxo")
    .description("Safely orchestrate Codex against external Git repositories")
    .version("0.1.0")
    .option("--debug", "show stack traces for errors", false)
    .configureOutput({
      writeOut: (message) => output.write(message.trimEnd()),
      writeErr: (message) => output.writeError(message.trimEnd()),
    })
    .showHelpAfterError()
    .exitOverride((error) => {
      if (error.code === "commander.helpDisplayed" || error.code === "commander.version") {
        return;
      }
      throw commanderErrorToDomainError(error);
    });

  return program;
}

function commanderErrorToDomainError(error: CommanderError): OrchestratorError {
  return new OrchestratorError(error.message, {
    code: "CLI_INPUT",
    cause: error,
  });
}
