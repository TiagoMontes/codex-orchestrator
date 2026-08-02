import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { execa } from "execa";
import { z } from "zod";
import type { DoctorCheck } from "./doctor-types.js";
import type { ConfigService } from "../configuration/config-service.js";
import type { StatePaths } from "../../infrastructure/persistence/state-paths.js";
import { LogRedactor } from "../../infrastructure/process/log-redactor.js";

const packageMetadataSchema = z.object({ version: z.string().min(1) }).passthrough();

export class LocalDoctorSystem {
  private readonly redactor = new LogRedactor();

  constructor(
    private readonly configService: ConfigService,
    private readonly paths: StatePaths = configService.paths,
  ) {}

  async checks(): Promise<DoctorCheck[]> {
    const node = this.checkNode();
    const [git, codexCli, codexSdk, state, worktree, configuration] = await Promise.all([
      this.checkExecutable("git", ["--version"], "Git"),
      this.checkExecutable("codex", ["--version"], "Codex CLI", true),
      this.checkCodexSdk(),
      this.checkStateDirectory(),
      this.checkWorktreeSupport(),
      this.checkConfiguration(),
    ]);
    return [node, git, codexCli, codexSdk, state, worktree, configuration];
  }

  private checkNode(): DoctorCheck {
    const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
    return {
      name: "node",
      status: major >= 20 ? "pass" : "fail",
      message: `Node ${process.versions.node}${major >= 20 ? "" : " (Node 20 or later is required)"}`,
    };
  }

  private async checkExecutable(
    command: string,
    argv: string[],
    label: string,
    unavailableIsWarning = false,
  ): Promise<DoctorCheck> {
    try {
      const result = await execa(command, argv, { reject: false, timeout: 10_000 });
      const text = this.redactor.redact(`${result.stdout}\n${result.stderr}`).trim();
      return {
        name: command,
        status: result.exitCode === 0 ? "pass" : unavailableIsWarning ? "warn" : "fail",
        message: result.exitCode === 0 ? firstUsefulLine(text, label) : `${label} check failed`,
      };
    } catch {
      return {
        name: command,
        status: unavailableIsWarning ? "warn" : "fail",
        message: `${label} is not available`,
      };
    }
  }

  private async checkCodexSdk(): Promise<DoctorCheck> {
    try {
      const entry = fileURLToPath(import.meta.resolve("@openai/codex-sdk"));
      const metadataPath = join(dirname(entry), "..", "package.json");
      const metadata = packageMetadataSchema.parse(
        JSON.parse(await readFile(metadataPath, "utf8")) as unknown,
      );
      return {
        name: "codex-sdk",
        status: "pass",
        message: `@openai/codex-sdk ${metadata.version}`,
      };
    } catch {
      return {
        name: "codex-sdk",
        status: "warn",
        message: "@openai/codex-sdk is not installed",
      };
    }
  }

  private async checkStateDirectory(): Promise<DoctorCheck> {
    try {
      await this.paths.ensureBaseDirectories();
      await import("node:fs/promises").then(async ({ access, constants }) =>
        access(this.paths.home, constants.R_OK | constants.W_OK),
      );
      return {
        name: "state",
        status: "pass",
        message: `State directory is writable: ${this.paths.home}`,
      };
    } catch {
      return {
        name: "state",
        status: "fail",
        message: `State directory is not writable: ${this.paths.home}`,
      };
    }
  }

  private async checkWorktreeSupport(): Promise<DoctorCheck> {
    await this.paths.ensureBaseDirectories().catch(() => undefined);
    let temporaryRepository: string | undefined;
    try {
      temporaryRepository = await mkdtemp(join(this.paths.tempDirectory, "doctor-git-"));
      const initialized = await execa("git", ["init", "--quiet"], {
        cwd: temporaryRepository,
        reject: false,
        timeout: 10_000,
      });
      const worktree = await execa("git", ["worktree", "list", "--porcelain"], {
        cwd: temporaryRepository,
        reject: false,
        timeout: 10_000,
      });
      const passed = initialized.exitCode === 0 && worktree.exitCode === 0;
      return {
        name: "git-worktree",
        status: passed ? "pass" : "fail",
        message: passed ? "Git worktree support is available" : "Git worktree support check failed",
      };
    } catch {
      return {
        name: "git-worktree",
        status: "fail",
        message: "Git worktree support is unavailable",
      };
    } finally {
      if (temporaryRepository !== undefined) {
        await rm(temporaryRepository, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  private async checkConfiguration(): Promise<DoctorCheck> {
    try {
      const result = await this.configService.validate();
      return {
        name: "configuration",
        status: "pass",
        message: `Configuration schema ${result.schemaVersion} is valid`,
      };
    } catch (error) {
      const missing = error instanceof Error && error.message.startsWith("Configuration not found");
      return {
        name: "configuration",
        status: missing ? "warn" : "fail",
        message: missing
          ? "Configuration is not initialized; run cxo config init"
          : "Configuration is invalid",
      };
    }
  }
}

function firstUsefulLine(text: string, fallback: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line !== "" && !line.startsWith("WARNING:")) ?? fallback
  );
}
