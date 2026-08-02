import { Command } from "commander";
import type { CommanderError } from "commander";
import type { OutputWriter } from "./output.js";
import { consoleOutput } from "./output.js";
import { OrchestratorError } from "../shared/errors.js";
import { ConfigService } from "../application/configuration/config-service.js";
import { registerConfigCommand } from "./commands/config.command.js";
import type { DoctorRunner } from "../application/doctor/doctor-types.js";
import { DoctorService } from "../application/doctor/doctor-service.js";
import { registerDoctorCommand } from "./commands/doctor.command.js";

export type ProgramDependencies = {
  output?: OutputWriter;
  configService?: ConfigService;
  doctorService?: DoctorRunner;
};

export function createProgram(dependencies: ProgramDependencies = {}): Command {
  const output = dependencies.output ?? consoleOutput;
  const configService = dependencies.configService ?? new ConfigService();
  const doctorService = dependencies.doctorService ?? new DoctorService(configService);
  const program = new Command();

  program
    .name("cxo")
    .description("Safely orchestrate Codex against external Git repositories")
    .version("0.1.0")
    .option("--debug", "show stack traces for errors", false)
    .option("--json", "emit machine-readable JSON", false)
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

  registerConfigCommand(program, configService, output);
  registerDoctorCommand(program, doctorService, output);

  return program;
}

function commanderErrorToDomainError(error: CommanderError): OrchestratorError {
  return new OrchestratorError(error.message, {
    code: "CLI_INPUT",
    cause: error,
  });
}
