import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { mkdir, open, rename, unlink } from "node:fs/promises";

export type AtomicWriteHooks = {
  beforeRename?: (temporaryPath: string, targetPath: string) => Promise<void>;
};

export class AtomicFileWriter {
  constructor(private readonly hooks: AtomicWriteHooks = {}) {}

  async writeText(targetPath: string, contents: string, mode = 0o600): Promise<void> {
    const targetDirectory = dirname(targetPath);
    await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
    const temporaryPath = join(
      targetDirectory,
      `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
    );

    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporaryPath, "wx", mode);
      await handle.writeFile(contents, { encoding: "utf8" });
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.hooks.beforeRename?.(temporaryPath, targetPath);
      await rename(temporaryPath, targetPath);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}
