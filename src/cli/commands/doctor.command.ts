import type { Command } from "commander";
import type { DoctorRunner } from "../../application/doctor/doctor-types.js";
import { DEEP_WARNING } from "../../application/doctor/doctor-service.js";
import type { OutputWriter } from "../output.js";
import { writeResult } from "../output.js";

export function registerDoctorCommand(
  program: Command,
  doctor: DoctorRunner,
  output: OutputWriter,
): void {
  program
    .command("doctor")
    .description("Check local prerequisites without spending model tokens")
    .option("--deep", "perform a tiny read-only Codex authentication/model probe", false)
    .action(async (options: { deep: boolean }) => {
      if (options.deep) {
        output.writeError(`Warning: ${DEEP_WARNING}`);
      }
      const report = await doctor.run({ deep: options.deep });
      if (program.opts<{ json?: boolean }>().json ?? false) {
        writeResult(output, report, true);
        return;
      }
      output.write(`Doctor status: ${report.overallStatus}`);
      for (const check of report.checks) {
        output.write(`[${check.status}] ${check.name}: ${check.message}`);
      }
      output.write(`Model call performed: ${report.modelCallPerformed ? "yes" : "no"}`);
    });
}
