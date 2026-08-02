import type { AppConfig, ExecutionProfile } from "../../application/configuration/config-schema.js";

export function profileLimits(
  config: AppConfig,
  profile: ExecutionProfile,
): AppConfig["profiles"][ExecutionProfile] {
  return config.profiles[profile];
}
