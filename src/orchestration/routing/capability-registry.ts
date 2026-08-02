import type { AppConfig } from "../../application/configuration/config-schema.js";

export type ModelAlias = keyof AppConfig["models"]["aliases"];

export class CapabilityRegistry {
  constructor(private readonly config: AppConfig) {}

  resolve(alias: ModelAlias): string {
    return this.config.models.aliases[alias];
  }

  aliasFor(model: string): ModelAlias | undefined {
    return (Object.entries(this.config.models.aliases) as Array<[ModelAlias, string]>).find(
      ([, configured]) => configured === model,
    )?.[0];
  }

  isCapable(model: string): boolean {
    return model === this.config.models.aliases.capable;
  }
}
