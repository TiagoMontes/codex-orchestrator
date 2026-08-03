import type { Command } from "commander";
import { join } from "node:path";
import type { ConfigService } from "../../application/configuration/config-service.js";
import type { ProjectManager } from "../../application/projects/project-service.js";
import type { Project } from "../../domain/project/project.js";
import type { OutputWriter } from "../output.js";
import { codexProgressWriter, writeResult } from "../output.js";
import type {
  ProjectAuditOverrides,
  ProjectAuditor,
} from "../../application/auditing/project-audit-service.js";
import type { ProjectRefresher } from "../../application/auditing/project-refresh-service.js";
import {
  executionProfileSchema,
  reasoningPresetSchema,
} from "../../application/configuration/config-schema.js";
import { OrchestratorError } from "../../shared/errors.js";
import { parseCliValue } from "../validation.js";

export function registerProjectCommands(
  program: Command,
  projects: ProjectManager,
  config: ConfigService,
  output: OutputWriter,
  auditor?: ProjectAuditor,
  refresher?: ProjectRefresher,
): void {
  const project = program.command("project").description("Register and inspect external projects");

  project
    .command("add")
    .argument("<path>", "path inside a Git repository")
    .option("--name <name>", "stable display name")
    .option("--base-ref <ref>", "base Git ref")
    .description("Register an external Git repository without modifying it")
    .action(async (path: string, options: { name?: string; baseRef?: string }) => {
      await config.load();
      const registered = await projects.add({
        path,
        ...(options.name === undefined ? {} : { name: options.name }),
        ...(options.baseRef === undefined ? {} : { baseRef: options.baseRef }),
      });
      emitProject(program, output, registered, `Registered ${registered.name} as ${registered.id}`);
    });

  project
    .command("list")
    .description("List registered projects")
    .action(async () => {
      await config.load();
      const registered = await projects.list();
      if (isJson(program)) {
        writeResult(output, { projects: registered }, true);
      } else if (registered.length === 0) {
        output.write("No projects registered.");
      } else {
        for (const item of registered) {
          output.write(`${item.id}\t${item.name}\t${item.gitRoot}\t${item.baseRef}`);
        }
      }
    });

  project
    .command("inspect")
    .argument("<project>", "project ID or unique name")
    .description("Show a registered project's metadata")
    .action(async (reference: string) => {
      await config.load();
      const found = await projects.inspect(reference);
      emitProject(
        program,
        output,
        found,
        formatProject(found, join(config.paths.projectDirectory(found.id), "project-config.yaml")),
      );
    });

  project
    .command("remove")
    .argument("<project>", "project ID or unique name")
    .description("Remove only orchestrator registration and state")
    .action(async (reference: string) => {
      await config.load();
      const removed = await projects.remove(reference);
      emitProject(
        program,
        output,
        removed,
        `Removed registration ${removed.id}; target repository was untouched`,
      );
    });

  if (auditor !== undefined) {
    project
      .command("audit")
      .argument("<project>", "project ID or unique name")
      .option("--profile <profile>")
      .option("--model <model-id>")
      .option("--reasoning <preset>")
      .option("--max-total-tokens <number>")
      .option("--max-agent-calls <number>")
      .option("--parallel-readers <number>")
      .option("--allow-network", "explicitly enable network for this execution", false)
      .option("--timeout <duration>")
      .description("Generate five commit-scoped, evidenced repository knowledge artifacts")
      .action(async (reference: string, options: Record<string, string | boolean | undefined>) => {
        const json = isJson(program);
        if (!json) output.write("[audit] starting commit-scoped repository audit");
        const report = await auditor.audit(reference, {
          ...parseAuditOverrides(options),
          ...(json ? {} : { progress: codexProgressWriter(output) }),
        });
        if (json) {
          writeResult(output, report, true);
          return;
        }
        output.write(`Audit: ${report.manifest.auditRunId}`);
        output.write(`Source: ${report.manifest.sourceCommit}; stale: ${report.manifest.stale}`);
        output.write(`Business rules: ${report.artifacts.businessRules.payload.rules.length}`);
        output.write(`Evidence: ${report.artifacts.repositoryMap.evidenceReferences.length}`);
        output.write(`Usage: ${report.usage.totalTokens} tokens (${report.usage.source})`);
      });
  }

  if (refresher !== undefined) {
    project
      .command("refresh")
      .argument("<project>", "project ID or unique name")
      .description("Refresh deterministic metadata and knowledge staleness")
      .action(async (reference: string) => {
        await config.load();
        const report = await refresher.refresh(reference);
        if (isJson(program)) {
          writeResult(output, report, true);
          return;
        }
        output.write(`Refreshed ${report.project.id} at ${report.project.currentHeadCommit}`);
        output.write(
          report.freshness === undefined
            ? "Knowledge: not audited"
            : `Knowledge: ${report.freshness.stale ? "stale" : "fresh"}; usable: ${report.freshness.usable}`,
        );
      });
  }
}

function parseAuditOverrides(
  options: Record<string, string | boolean | undefined>,
): ProjectAuditOverrides {
  return {
    ...(typeof options.profile === "string"
      ? { profile: parseCliValue(executionProfileSchema, options.profile, "--profile") }
      : {}),
    ...(typeof options.model === "string" ? { model: options.model } : {}),
    ...(typeof options.reasoning === "string"
      ? { reasoning: parseCliValue(reasoningPresetSchema, options.reasoning, "--reasoning") }
      : {}),
    ...(typeof options.maxTotalTokens === "string"
      ? { maxTotalTokens: positiveInteger(options.maxTotalTokens, "max-total-tokens") }
      : {}),
    ...(typeof options.maxAgentCalls === "string"
      ? { maxAgentCalls: positiveInteger(options.maxAgentCalls, "max-agent-calls") }
      : {}),
    ...(typeof options.parallelReaders === "string"
      ? { parallelReaders: nonnegativeInteger(options.parallelReaders, "parallel-readers") }
      : {}),
    ...(options.allowNetwork === true ? { allowNetwork: true } : {}),
    ...(typeof options.timeout === "string" ? { timeoutMs: parseDuration(options.timeout) } : {}),
  };
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new OrchestratorError(`--${name} must be a positive integer`, { code: "CLI_INPUT" });
  }
  return parsed;
}

function nonnegativeInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new OrchestratorError(`--${name} must be a nonnegative integer`, { code: "CLI_INPUT" });
  }
  return parsed;
}

function parseDuration(value: string): number {
  const match = /^(\d+)(ms|s|m)?$/u.exec(value);
  if (match === null) {
    throw new OrchestratorError("--timeout must look like 500ms, 30s, or 5m", {
      code: "CLI_INPUT",
    });
  }
  const amount = Number(match[1]);
  const multiplier = match[2] === "m" ? 60_000 : match[2] === "s" ? 1_000 : 1;
  return positiveInteger(String(amount * multiplier), "timeout");
}

function emitProject(
  program: Command,
  output: OutputWriter,
  project: Project,
  human: string,
): void {
  writeResult(output, isJson(program) ? project : human, isJson(program));
}

function formatProject(project: Project, projectConfigPath: string): string {
  return [
    `Project: ${project.id} (${project.name})`,
    `Repository: ${project.gitRoot}`,
    `Base: ${project.baseRef} @ ${project.registeredHeadCommit}`,
    `Stack: ${project.detectedStack.languages.join(", ") || "unknown"}`,
    `Instructions: ${project.instructionFiles.length}`,
    `Skills: ${project.skillMetadata.length}`,
    `Project config: ${projectConfigPath}`,
    `Approved verification commands: ${
      [...project.verificationPolicy.focused, ...project.verificationPolicy.full].filter(
        (command) => command.approved,
      ).length
    }`,
    `Verification candidates: ${project.verificationPolicy.candidates.length}`,
  ].join("\n");
}

function isJson(program: Command): boolean {
  return program.opts<{ json?: boolean }>().json ?? false;
}
