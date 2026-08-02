import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSafePath } from "../../../src/infrastructure/filesystem/path-safety.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true })),
  );
});

describe("resolveSafePath", () => {
  it("allows existing and future paths contained by the root", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cxo-path-"));
    temporaryDirectories.push(directory);
    const root = join(directory, "root");
    await mkdir(root);
    await writeFile(join(root, "file.txt"), "safe", "utf8");
    const canonicalRoot = await realpath(root);

    await expect(resolveSafePath(root, "file.txt")).resolves.toBe(join(canonicalRoot, "file.txt"));
    await expect(resolveSafePath(root, "new/file.txt", { allowMissing: true })).resolves.toBe(
      join(canonicalRoot, "new/file.txt"),
    );
  });

  it("rejects parent traversal and symlink escapes, including missing descendants", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cxo-path-"));
    temporaryDirectories.push(directory);
    const root = join(directory, "root");
    const outside = join(directory, "outside");
    await mkdir(root);
    await mkdir(outside);
    await symlink(outside, join(root, "escape"));

    await expect(resolveSafePath(root, "../outside")).rejects.toThrow("Parent path segments");
    await expect(resolveSafePath(root, "escape/new.txt", { allowMissing: true })).rejects.toThrow(
      "escapes allowed root",
    );
  });
});
