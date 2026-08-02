import { createProgram } from "./cli/program.js";
import { handleCliError } from "./cli/errors.js";
import { consoleOutput } from "./cli/output.js";

async function main(): Promise<void> {
  const program = createProgram({ output: consoleOutput });
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    const options = program.opts<{ debug?: boolean; json?: boolean }>();
    process.exitCode = handleCliError(error, consoleOutput, {
      debug: options.debug === true || process.argv.includes("--debug"),
      json: options.json === true || process.argv.includes("--json"),
    });
  }
}

await main();
