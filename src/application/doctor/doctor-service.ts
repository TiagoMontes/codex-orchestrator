import type { DeepDoctorProbe, DoctorCheck, DoctorReport, DoctorRunner } from "./doctor-types.js";
import { LocalDoctorSystem } from "./local-doctor-system.js";
import { ConfigService } from "../configuration/config-service.js";
import { DEFAULT_CONFIG } from "../configuration/default-config.js";
import { CliDeepDoctorProbe } from "../../infrastructure/codex/cli-deep-doctor-probe.js";

const DEEP_WARNING = "Deep doctor performs a tiny read-only Codex call and may consume usage.";

export class DoctorService implements DoctorRunner {
  private readonly system: LocalDoctorSystem;
  private readonly deepProbe: DeepDoctorProbe;

  constructor(
    private readonly configService = new ConfigService(),
    options: { system?: LocalDoctorSystem; deepProbe?: DeepDoctorProbe } = {},
  ) {
    this.system = options.system ?? new LocalDoctorSystem(configService);
    this.deepProbe = options.deepProbe ?? new CliDeepDoctorProbe(configService.paths);
  }

  async run(options: { deep: boolean }): Promise<DoctorReport> {
    const checks = await this.system.checks();
    let modelCallPerformed = false;

    if (options.deep) {
      const config = await this.configService.load().catch(() => DEFAULT_CONFIG);
      modelCallPerformed = true;
      try {
        const message = await this.deepProbe.run({
          model: config.models.aliases.fast,
          timeoutMs: Math.min(config.runtime.defaultTimeoutSeconds * 1_000, 120_000),
        });
        checks.push({ name: "codex-deep", status: "pass", message });
      } catch (error) {
        checks.push({
          name: "codex-deep",
          status: "fail",
          message: error instanceof Error ? error.message : "Codex deep probe failed",
        });
      }
    }

    return {
      schemaVersion: 1,
      overallStatus: overallStatus(checks),
      deep: options.deep,
      modelCallPerformed,
      ...(options.deep ? { warning: DEEP_WARNING } : {}),
      checks,
    };
  }
}

function overallStatus(checks: readonly DoctorCheck[]): DoctorReport["overallStatus"] {
  if (checks.some((check) => check.status === "fail")) {
    return "failed";
  }
  if (checks.some((check) => check.status === "warn")) {
    return "degraded";
  }
  return "healthy";
}

export { DEEP_WARNING };
