import { access, constants, readFile } from "node:fs/promises";
import { parse, stringify } from "yaml";
import { appConfigSchema, type AppConfig } from "./config-schema.js";
import { DEFAULT_CONFIG } from "./default-config.js";
import { OrchestratorError } from "../../shared/errors.js";
import { AtomicFileWriter } from "../../infrastructure/persistence/atomic-file-writer.js";
import { StatePaths } from "../../infrastructure/persistence/state-paths.js";

export type ConfigInitResult = {
  path: string;
  created: true;
  config: AppConfig;
};

export class ConfigService {
  constructor(
    readonly paths = new StatePaths(),
    private readonly writer = new AtomicFileWriter(),
  ) {}

  async initialize(): Promise<ConfigInitResult> {
    await this.paths.ensureBaseDirectories();
    if (await pathExists(this.paths.configFile)) {
      throw new OrchestratorError(`Configuration already exists at ${this.paths.configFile}`, {
        code: "CONFIGURATION",
        nextCommand: "cxo config validate",
      });
    }
    await this.writer.writeText(this.paths.configFile, stringify(DEFAULT_CONFIG));
    return { path: this.paths.configFile, created: true, config: DEFAULT_CONFIG };
  }

  async load(): Promise<AppConfig> {
    let contents: string;
    try {
      contents = await readFile(this.paths.configFile, "utf8");
    } catch (error) {
      throw new OrchestratorError(`Configuration not found at ${this.paths.configFile}`, {
        code: "CONFIGURATION",
        nextCommand: "cxo config init",
        cause: error,
      });
    }

    let input: unknown;
    try {
      input = parse(contents) as unknown;
    } catch (error) {
      throw new OrchestratorError(`Configuration is not valid YAML: ${this.paths.configFile}`, {
        code: "CONFIGURATION",
        cause: error,
      });
    }

    const parsed = appConfigSchema.safeParse(input);
    if (!parsed.success) {
      throw new OrchestratorError(`Configuration failed validation: ${this.paths.configFile}`, {
        code: "CONFIGURATION",
        cause: parsed.error,
      });
    }
    return parsed.data;
  }

  async showYaml(): Promise<string> {
    return stringify(await this.load());
  }

  async validate(): Promise<{ valid: true; path: string; schemaVersion: number }> {
    const config = await this.load();
    return { valid: true, path: this.paths.configFile, schemaVersion: config.schemaVersion };
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
