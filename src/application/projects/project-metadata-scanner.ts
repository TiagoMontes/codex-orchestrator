import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { InstructionFileReference, SkillMetadata } from "../../domain/project/project.js";
import { sha256 } from "../../shared/hashing.js";

const frontmatterSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
  })
  .passthrough();

const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "coverage",
]);

export class ProjectMetadataScanner {
  async scan(gitRoot: string): Promise<{
    instructionFiles: InstructionFileReference[];
    skillMetadata: SkillMetadata[];
  }> {
    const files = await walkFiles(gitRoot, 10_000, 12);
    const instructionPaths = files.filter((path) => {
      const name = basename(path);
      return name === "AGENTS.md" || name === "AGENTS.override.md";
    });
    const skillPaths = files.filter((path) =>
      relative(gitRoot, path)
        .split(/[\\/]/u)
        .join("/")
        .match(/^\.agents\/skills\/[^/]+\/SKILL\.md$/u),
    );

    const instructionFiles = await Promise.all(
      instructionPaths.sort().map(async (path) => {
        const contents = await readFile(path);
        return {
          path,
          relativePath: relative(gitRoot, path),
          sha256: sha256(contents),
        };
      }),
    );
    const skillMetadata = await Promise.all(
      skillPaths.sort().map(async (path) => {
        const contents = await readFile(path, "utf8");
        const metadata = parseFrontmatter(contents);
        return {
          name: metadata.name ?? basename(join(path, "..")),
          description: metadata.description ?? "",
          path,
          relativePath: relative(gitRoot, path),
          sha256: sha256(contents),
          source: "project" as const,
          tags: metadata.tags ?? [],
        };
      }),
    );
    return { instructionFiles, skillMetadata };
  }
}

async function walkFiles(root: string, maxFiles: number, maxDepth: number): Promise<string[]> {
  const files: string[] = [];
  const pending: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
  for (let index = 0; index < pending.length && files.length < maxFiles; index += 1) {
    const current = pending[index];
    if (current === undefined || current.depth > maxDepth) continue;
    const entries = await readdir(current.directory, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      const path = join(current.directory, entry.name);
      if (entry.isFile()) {
        files.push(path);
      } else if (entry.isDirectory() && !EXCLUDED_DIRECTORIES.has(entry.name)) {
        pending.push({ directory: path, depth: current.depth + 1 });
      }
    }
  }
  return files;
}

function parseFrontmatter(contents: string): z.infer<typeof frontmatterSchema> {
  if (!contents.startsWith("---\n")) return {};
  const end = contents.indexOf("\n---", 4);
  if (end === -1) return {};
  try {
    return frontmatterSchema.parse(parse(contents.slice(4, end)) as unknown);
  } catch {
    return {};
  }
}
