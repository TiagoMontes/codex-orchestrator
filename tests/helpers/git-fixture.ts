import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";

export async function createGitFixture(root: string): Promise<void> {
  await mkdir(join(root, ".agents", "skills", "fixture-skill"), { recursive: true });
  await mkdir(join(root, "test"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "fixture-project",
        version: "1.0.0",
        type: "module",
        scripts: { test: "node --test", lint: "eslint ." },
        dependencies: { express: "1.0.0" },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    join(root, "AGENTS.md"),
    "# Fixture instructions\n\nDo not change the public API.\n",
    "utf8",
  );
  await writeFile(
    join(root, ".agents", "skills", "fixture-skill", "SKILL.md"),
    "---\nname: fixture-skill\ndescription: Inspect the fixture.\ntags: [test]\n---\n\nRead only.\n",
    "utf8",
  );
  await writeFile(join(root, "index.js"), "export const publicValue = 1;\n", "utf8");
  await writeFile(
    join(root, "test", "index.test.js"),
    'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { publicValue } from "../index.js";\ntest("public value", () => assert.equal(publicValue, 1));\n',
    "utf8",
  );
  await runGit(root, ["init", "--initial-branch=main"]);
  await runGit(root, ["config", "user.email", "fixture@example.test"]);
  await runGit(root, ["config", "user.name", "Fixture"]);
  await runGit(root, ["add", "."]);
  await runGit(root, ["commit", "-m", "feat: fixture baseline"]);
  await runGit(root, [
    "remote",
    "add",
    "origin",
    "https://fixture-user:fixture-token@example.test/org/repo.git?token=hidden",
  ]);
}

export async function gitOutput(root: string, argv: string[]): Promise<string> {
  return (await execa("git", ["-C", root, ...argv])).stdout;
}

async function runGit(root: string, argv: string[]): Promise<void> {
  await execa("git", ["-C", root, ...argv]);
}
