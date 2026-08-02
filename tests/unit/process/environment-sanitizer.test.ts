import { describe, expect, it } from "vitest";
import { EnvironmentSanitizer } from "../../../src/infrastructure/process/environment-sanitizer.js";

describe("EnvironmentSanitizer", () => {
  it("keeps operational values and drops unrelated or sensitive values", () => {
    const sanitizer = new EnvironmentSanitizer();
    const result = sanitizer.sanitize(
      {
        PATH: "/usr/bin",
        HOME: "/tmp/home",
        NODE_OPTIONS: "--require attack.js",
        API_TOKEN: "secret",
        SAFE_PROJECT_SETTING: "on",
      },
      { additionalAllowedNames: ["API_TOKEN", "SAFE_PROJECT_SETTING"] },
    );

    expect(result.environment).toEqual({
      HOME: "/tmp/home",
      PATH: "/usr/bin",
      SAFE_PROJECT_SETTING: "on",
    });
    expect(result.warnings).toContain("Omitted sensitive environment variable API_TOKEN");
  });

  it("allows a named sensitive exception while warning without exposing its value", () => {
    const result = new EnvironmentSanitizer().sanitize(
      { SERVICE_KEY: "super-secret" },
      { additionalAllowedNames: ["SERVICE_KEY"], explicitSecretExceptions: ["SERVICE_KEY"] },
    );

    expect(result.environment.SERVICE_KEY).toBe("super-secret");
    expect(result.warnings.join(" ")).not.toContain("super-secret");
  });
});
