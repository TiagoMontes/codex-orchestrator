import { createProgram } from "./cli/program.js";
import { handleCliError } from "./cli/errors.js";
import { consoleOutput } from "./cli/output.js";

async function main(): Promise<void> {
  const program = createProgram({ output: consoleOutput });
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    const debug = program.opts<{ debug?: boolean }>().debug ?? false;
    process.exitCode = handleCliError(error, consoleOutput, debug);
  }
}

await main();
