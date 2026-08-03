import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { execa } from "execa";
import type { DeepDoctorProbe } from "../../application/doctor/doctor-types.js";
import type { StatePaths } from "../persistence/state-paths.js";
import { EnvironmentSanitizer } from "../process/environment-sanitizer.js";
import { LogRedactor } from "../process/log-redactor.js";
import { GitClientFactory } from "../git/git-client-factory.js";

export class CliDeepDoctorProbe implements DeepDoctorProbe {
  constructor(
    private readonly paths: StatePaths,
    private readonly sanitizer = new EnvironmentSanitizer(),
    private readonly redactor = new LogRedactor(),
  ) {}

  async run(options: { model: string; timeoutMs: number }): Promise<string> {
    await this.paths.ensureBaseDirectories();
    const repository = await mkdtemp(join(this.paths.tempDirectory, "doctor-codex-"));
    try {
      await new GitClientFactory(this.paths)
        .global({ phase: "doctor-deep" })
        .initializeEmptyRepository(repository);

      const environment = this.sanitizer.sanitize(process.env).environment;
      const result = await execa(
        "codex",
        [
          "exec",
          "--ephemeral",
          "--ignore-user-config",
          "--sandbox",
          "read-only",
          "--cd",
          repository,
          "--model",
          options.model,
          "--color",
          "never",
          "--json",
          "-c",
          'approval_policy="never"',
          "Return exactly the word OK. Do not run commands, inspect files, or use tools.",
        ],
        {
          cwd: repository,
          env: environment,
          reject: false,
          timeout: options.timeoutMs,
          maxBuffer: 1_000_000,
        },
      );
      if (result.exitCode !== 0) {
        const excerpt = this.redactor.redact(result.stderr).trim().slice(-1_000);
        throw new Error(excerpt === "" ? "Codex deep probe failed" : excerpt);
      }
      return "Tiny read-only Codex call succeeded";
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  }
}
