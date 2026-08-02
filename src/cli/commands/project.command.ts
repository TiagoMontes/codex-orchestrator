import type { Command } from "commander";
import type { ConfigService } from "../../application/configuration/config-service.js";
import type { ProjectManager } from "../../application/projects/project-service.js";
import type { Project } from "../../domain/project/project.js";
import type { OutputWriter } from "../output.js";
import { writeResult } from "../output.js";

export function registerProjectCommands(
  program: Command,
  projects: ProjectManager,
  config: ConfigService,
  output: OutputWriter,
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
      emitProject(program, output, found, formatProject(found));
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
}

function emitProject(
  program: Command,
  output: OutputWriter,
  project: Project,
  human: string,
): void {
  writeResult(output, isJson(program) ? project : human, isJson(program));
}

function formatProject(project: Project): string {
  return [
    `Project: ${project.id} (${project.name})`,
    `Repository: ${project.gitRoot}`,
    `Base: ${project.baseRef} @ ${project.registeredHeadCommit}`,
    `Stack: ${project.detectedStack.languages.join(", ") || "unknown"}`,
    `Instructions: ${project.instructionFiles.length}`,
    `Skills: ${project.skillMetadata.length}`,
    `Verification candidates: ${project.verificationPolicy.candidates.length}`,
  ].join("\n");
}

function isJson(program: Command): boolean {
  return program.opts<{ json?: boolean }>().json ?? false;
}
