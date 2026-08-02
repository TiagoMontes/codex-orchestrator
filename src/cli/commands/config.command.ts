import type { Command } from "commander";
import type { ConfigService } from "../../application/configuration/config-service.js";
import type { OutputWriter } from "../output.js";
import { writeResult } from "../output.js";

export function registerConfigCommand(
  program: Command,
  configService: ConfigService,
  output: OutputWriter,
): void {
  const config = program.command("config").description("Manage orchestrator configuration");

  config
    .command("init")
    .description("Create the default configuration and state directories")
    .action(async () => {
      const result = await configService.initialize();
      writeResult(
        output,
        isJson(program) ? result : `Initialized configuration at ${result.path}`,
        isJson(program),
      );
    });

  config
    .command("show")
    .description("Show the validated effective configuration")
    .action(async () => {
      if (isJson(program)) {
        writeResult(output, await configService.load(), true);
      } else {
        output.write((await configService.showYaml()).trimEnd());
      }
    });

  config
    .command("path")
    .description("Show the configuration path")
    .action(() => {
      const path = configService.paths.configFile;
      writeResult(output, isJson(program) ? { path } : path, isJson(program));
    });

  config
    .command("validate")
    .description("Validate configuration syntax and values")
    .action(async () => {
      const result = await configService.validate();
      writeResult(
        output,
        isJson(program)
          ? result
          : `Configuration is valid (schema ${result.schemaVersion}): ${result.path}`,
        isJson(program),
      );
    });
}

function isJson(program: Command): boolean {
  return program.opts<{ json?: boolean }>().json ?? false;
}
