import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OrchestratorError } from "../shared/errors.js";

export class PromptLoader {
  async load(name: string): Promise<string> {
    const moduleDirectory = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      join(moduleDirectory, "..", "..", "prompts", name),
      join(moduleDirectory, "..", "prompts", name),
    ];
    for (const path of candidates) {
      try {
        return await readFile(path, "utf8");
      } catch {
        // Try the source-tree and bundled-package layouts, in that order.
      }
    }
    throw new OrchestratorError(`Prompt template not found: ${name}`, { code: "CONFIGURATION" });
  }

  async render(name: string, variables: Readonly<Record<string, string>>): Promise<string> {
    let prompt = await this.load(name);
    for (const [key, value] of Object.entries(variables)) {
      prompt = prompt.replaceAll(`{{${key}}}`, value);
    }
    return prompt;
  }
}
