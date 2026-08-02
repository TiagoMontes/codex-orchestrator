import { readFile } from "node:fs/promises";
import type { ZodType } from "zod";
import { OrchestratorError } from "../../shared/errors.js";
import { AtomicFileWriter } from "./atomic-file-writer.js";

export class AtomicJsonStore {
  constructor(private readonly writer = new AtomicFileWriter()) {}

  async write<T>(path: string, value: T): Promise<void> {
    await this.writer.writeText(path, `${JSON.stringify(value, null, 2)}\n`);
  }

  async readUnknown(path: string): Promise<unknown> {
    let contents: string;
    try {
      contents = await readFile(path, "utf8");
    } catch (error) {
      throw new OrchestratorError(`Unable to read state document at ${path}`, {
        code: "CONFIGURATION",
        cause: error,
      });
    }

    try {
      return JSON.parse(contents) as unknown;
    } catch (error) {
      throw new OrchestratorError(`State document is not valid JSON: ${path}`, {
        code: "CONFIGURATION",
        cause: error,
      });
    }
  }

  async read<T>(path: string, schema: ZodType<T>): Promise<T> {
    const input = await this.readUnknown(path);
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      throw new OrchestratorError(`State document failed validation: ${path}`, {
        code: "CONFIGURATION",
        cause: parsed.error,
      });
    }
    return parsed.data;
  }
}
