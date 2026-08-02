import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";
import type { Project, SkillMetadata } from "../../domain/project/project.js";
import type { ExecutionPhase } from "../../domain/execution/execution.js";
import type { Task } from "../../domain/task/task.js";
import { OrchestratorError } from "../../shared/errors.js";
import { sha256 } from "../../shared/hashing.js";
import { resolveSafePath } from "../../infrastructure/filesystem/path-safety.js";

const frontmatterSchema = z
  .object({
    name: z.string().min(1).max(128),
    description: z.string().max(1_000),
    tags: z.array(z.string().min(1).max(64)).max(32).optional(),
  })
  .passthrough();

export type RegisteredSkill = SkillMetadata & { instructions: string };
export type SelectedSkill = {
  name: string;
  sha256: string;
  source: SkillMetadata["source"];
  path: string;
  instructions: string;
  instructionsSha256: string;
};

export type SkillRegistryOptions = {
  bundledRoot?: string;
  userRoot?: string;
  allowUserSkills?: boolean;
  maxSelected?: number;
};

export class SkillRegistry {
  private readonly bundledRoot: string;
  private readonly userRoot: string;
  private readonly allowUserSkills: boolean;
  private readonly maxSelected: number;

  constructor(options: SkillRegistryOptions = {}) {
    this.bundledRoot = options.bundledRoot ?? defaultBundledRoot();
    this.userRoot = options.userRoot ?? join(homedir(), ".agents", "skills");
    this.allowUserSkills =
      options.allowUserSkills ?? process.env.CODEX_ORCHESTRATOR_ALLOW_USER_SKILLS === "1";
    this.maxSelected = options.maxSelected ?? 3;
  }

  async load(project?: Project): Promise<RegisteredSkill[]> {
    const bundled = await this.loadDirectory(this.bundledRoot, "bundled");
    const target = await Promise.all(
      (project?.skillMetadata ?? []).map(async (metadata) =>
        this.loadKnown(metadata, project?.gitRoot),
      ),
    );
    const user = this.allowUserSkills
      ? await this.loadDirectory(this.userRoot, "user").catch((error: unknown) => {
          if (isMissingPath(error)) return [];
          throw error;
        })
      : [];
    const byIdentity = new Map<string, RegisteredSkill>();
    for (const skill of [...bundled, ...target, ...user]) {
      byIdentity.set(`${skill.source}:${skill.name}`, skill);
    }
    return [...byIdentity.values()].sort((left, right) =>
      `${left.source}:${left.name}`.localeCompare(`${right.source}:${right.name}`),
    );
  }

  async select(input: {
    phase: ExecutionPhase;
    project?: Project;
    task?: Task;
  }): Promise<SelectedSkill[]> {
    const skills = await this.load(input.project);
    const preferred = preferredNames(input.phase, input.task);
    const ranked = skills
      .map((skill) => {
        const preferredIndex = skill.source === "bundled" ? preferred.indexOf(skill.name) : -1;
        return {
          skill,
          rank:
            preferredIndex >= 0
              ? preferredIndex
              : skill.source !== "bundled" && matchesTags(skill, input.phase, input.task)
                ? preferred.length
                : Number.POSITIVE_INFINITY,
        };
      })
      .filter((item) => Number.isFinite(item.rank))
      .sort(
        (left, right) =>
          left.rank - right.rank ||
          sourceRank(left.skill.source) - sourceRank(right.skill.source) ||
          left.skill.name.localeCompare(right.skill.name),
      );
    const requiredBundledNames = new Set(preferred);
    const selectedNames = new Set<string>();
    const unique: typeof ranked = [];
    for (const item of ranked) {
      if (selectedNames.has(item.skill.name)) continue;
      if (item.skill.source !== "bundled" && requiredBundledNames.has(item.skill.name)) continue;
      selectedNames.add(item.skill.name);
      unique.push(item);
      if (unique.length === this.maxSelected) break;
    }
    return unique.map(({ skill }) => ({
      name: skill.name,
      sha256: skill.sha256,
      source: skill.source,
      path: skill.path,
      instructions: skill.instructions,
      instructionsSha256: sha256(skill.instructions),
    }));
  }

  private async loadKnown(
    metadata: SkillMetadata,
    projectRoot: string | undefined,
  ): Promise<RegisteredSkill> {
    const root = projectRoot ?? dirname(dirname(metadata.path));
    const safePath = await resolveSafePath(root, metadata.path);
    const contents = await readBoundedSkill(safePath);
    if (sha256(contents) !== metadata.sha256) {
      throw new OrchestratorError(`Registered skill changed: ${metadata.relativePath}`, {
        code: "CONTEXT_INTEGRITY",
        resumable: true,
      });
    }
    return { ...metadata, instructions: stripFrontmatter(contents) };
  }

  private async loadDirectory(
    root: string,
    source: "bundled" | "user",
  ): Promise<RegisteredSkill[]> {
    const entries = await readdir(root, { withFileTypes: true });
    const paths = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name, "SKILL.md"))
      .sort();
    const loaded = await Promise.all(
      paths.map(async (path) => {
        let safePath: string;
        try {
          safePath = await resolveSafePath(root, path);
        } catch (error) {
          if (source === "user" && isMissingPath(error)) return undefined;
          throw error;
        }
        const contents = await readBoundedSkill(safePath);
        const metadata = parseFrontmatter(contents, path);
        return {
          name: metadata.name,
          description: metadata.description,
          path: safePath,
          relativePath: `${basename(dirname(path))}/SKILL.md`,
          sha256: sha256(contents),
          source,
          tags: metadata.tags ?? [],
          instructions: stripFrontmatter(contents),
        };
      }),
    );
    return loaded.filter(
      (skill): skill is NonNullable<(typeof loaded)[number]> => skill !== undefined,
    );
  }
}

async function readBoundedSkill(path: string): Promise<string> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > 64 * 1024) {
    throw new OrchestratorError(`Skill file is not a bounded regular file: ${path}`, {
      code: "CONFIGURATION",
    });
  }
  return readFile(path, "utf8");
}

function defaultBundledRoot(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  return basename(moduleDirectory) === "dist"
    ? join(moduleDirectory, "..", "skills")
    : join(moduleDirectory, "..", "..", "..", "skills");
}

function parseFrontmatter(contents: string, path: string): z.infer<typeof frontmatterSchema> {
  if (!contents.startsWith("---\n")) {
    throw new OrchestratorError(`Skill frontmatter is missing: ${path}`, { code: "CONFIGURATION" });
  }
  const end = contents.indexOf("\n---", 4);
  if (end < 0) {
    throw new OrchestratorError(`Skill frontmatter is unterminated: ${path}`, {
      code: "CONFIGURATION",
    });
  }
  return frontmatterSchema.parse(parse(contents.slice(4, end)) as unknown);
}

function stripFrontmatter(contents: string): string {
  const end = contents.indexOf("\n---", 4);
  return contents.slice(end + 4).trim();
}

function preferredNames(phase: ExecutionPhase, task?: Task): string[] {
  if (phase === "audit") return ["repository-audit", "business-rule-mapping"];
  if (phase === "diagnosis") return task?.type === "bugfix" ? ["bug-diagnosis"] : [];
  if (phase === "exploration")
    return task?.type === "audit" || task?.type === "investigation" ? ["repository-audit"] : [];
  if (phase === "implementation" || phase === "correction") return ["implement-with-tests"];
  if (phase === "review") return ["independent-review"];
  return [];
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function matchesTags(skill: RegisteredSkill, phase: ExecutionPhase, task?: Task): boolean {
  return skill.tags.includes(phase) || (task !== undefined && skill.tags.includes(task.type));
}

function sourceRank(source: SkillMetadata["source"]): number {
  return source === "project" ? 0 : source === "bundled" ? 1 : 2;
}
