import { access, constants, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type {
  DetectedStack,
  VerificationCommand,
  VerificationPolicy,
} from "../../domain/project/project.js";

const packageJsonSchema = z
  .object({
    scripts: z.record(z.string(), z.string()).optional(),
    dependencies: z.record(z.string(), z.string()).optional(),
    devDependencies: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

export type StackDetection = {
  stack: DetectedStack;
  verificationPolicy: VerificationPolicy;
};

export class StackDetector {
  async detect(gitRoot: string): Promise<StackDetection> {
    const rootEntries = await existingFiles(gitRoot, [
      "package.json",
      "pnpm-lock.yaml",
      "package-lock.json",
      "yarn.lock",
      "bun.lock",
      "composer.json",
      "pyproject.toml",
      "requirements.txt",
      "Cargo.toml",
      "go.mod",
      "Makefile",
    ]);
    const languages = new Set<string>();
    const packageManagers = new Set<string>();
    const frameworks = new Set<string>();
    const candidates: VerificationCommand[] = [];
    const full: VerificationCommand[] = [];

    if (rootEntries.includes("package.json")) {
      languages.add("JavaScript/TypeScript");
      const manager = detectNodePackageManager(rootEntries);
      packageManagers.add(manager);
      const packageJson = await readJsonPackage(join(gitRoot, "package.json"));
      for (const dependency of Object.keys({
        ...(packageJson.dependencies ?? {}),
        ...(packageJson.devDependencies ?? {}),
      })) {
        const framework = frameworkForDependency(dependency);
        if (framework !== undefined) {
          frameworks.add(framework);
        }
      }
      for (const script of ["test", "typecheck", "lint", "build"] as const) {
        if (packageJson.scripts?.[script] === undefined) {
          continue;
        }
        const command: VerificationCommand = {
          name: script,
          argv: nodeScriptArgv(manager, script),
          timeoutSeconds: script === "test" ? 600 : 300,
          source: `package.json#scripts.${script}`,
          approved: false,
        };
        candidates.push(command);
        if (script === "test" && packageJson.scripts[script].trim() === "node --test") {
          full.push({ ...command, argv: ["node", "--test"], approved: true });
        }
      }
    }
    if (rootEntries.includes("composer.json")) {
      languages.add("PHP");
      packageManagers.add("composer");
      candidates.push(candidate("test", ["composer", "test"], "composer.json", 600));
    }
    if (rootEntries.includes("pyproject.toml") || rootEntries.includes("requirements.txt")) {
      languages.add("Python");
      packageManagers.add("python");
      candidates.push(candidate("pytest", ["python", "-m", "pytest"], "Python manifest", 600));
    }
    if (rootEntries.includes("Cargo.toml")) {
      languages.add("Rust");
      packageManagers.add("cargo");
      candidates.push(candidate("cargo-test", ["cargo", "test"], "Cargo.toml", 600));
    }
    if (rootEntries.includes("go.mod")) {
      languages.add("Go");
      packageManagers.add("go");
      candidates.push(candidate("go-test", ["go", "test", "./..."], "go.mod", 600));
    }

    return {
      stack: {
        languages: [...languages].sort(),
        packageManagers: [...packageManagers].sort(),
        frameworks: [...frameworks].sort(),
        manifests: rootEntries.sort(),
      },
      verificationPolicy: { focused: [], full, candidates },
    };
  }
}

async function existingFiles(root: string, candidates: readonly string[]): Promise<string[]> {
  const checks = await Promise.all(
    candidates.map(async (name) => {
      try {
        await access(join(root, name), constants.R_OK);
        return name;
      } catch {
        return undefined;
      }
    }),
  );
  return checks.filter((name): name is string => name !== undefined);
}

async function readJsonPackage(path: string): Promise<z.infer<typeof packageJsonSchema>> {
  try {
    return packageJsonSchema.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch {
    return {};
  }
}

function detectNodePackageManager(entries: readonly string[]): string {
  if (entries.includes("pnpm-lock.yaml")) return "pnpm";
  if (entries.includes("yarn.lock")) return "yarn";
  if (entries.includes("bun.lock")) return "bun";
  return "npm";
}

function nodeScriptArgv(manager: string, script: string): string[] {
  if (manager === "npm") {
    return script === "test" ? ["npm", "test"] : ["npm", "run", script];
  }
  return [manager, "run", script];
}

function candidate(
  name: string,
  argv: string[],
  source: string,
  timeoutSeconds: number,
): VerificationCommand {
  return { name, argv, source, timeoutSeconds, approved: false };
}

function frameworkForDependency(dependency: string): string | undefined {
  const known: Readonly<Record<string, string>> = {
    express: "Express",
    fastify: "Fastify",
    nestjs: "NestJS",
    "@nestjs/core": "NestJS",
    next: "Next.js",
    react: "React",
    vue: "Vue",
    svelte: "Svelte",
  };
  return known[dependency];
}
