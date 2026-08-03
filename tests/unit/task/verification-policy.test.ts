import { describe, expect, it } from "vitest";
import { verificationPolicyHash } from "../../../src/application/tasks/verification-policy.js";
import type { VerificationPolicy } from "../../../src/domain/project/project.js";

const verificationPolicy: VerificationPolicy = {
  focused: [
    {
      name: "focused",
      argv: ["pnpm", "test"],
      timeoutSeconds: 60,
      source: "project-config.yaml",
      approved: true,
    },
  ],
  full: [],
  candidates: [],
};

describe("verificationPolicyHash", () => {
  it("binds verification evidence to the effective environment policy", () => {
    const baseline = verificationPolicyHash({
      verificationPolicy,
      environmentPolicy: { allowlist: ["CI"], secretExceptions: [] },
    });
    const changed = verificationPolicyHash({
      verificationPolicy,
      environmentPolicy: {
        allowlist: ["CI", "PRIVATE_REGISTRY_TOKEN"],
        secretExceptions: ["PRIVATE_REGISTRY_TOKEN"],
      },
    });

    expect(changed).not.toBe(baseline);
  });

  it("treats environment allowlists as name sets", () => {
    expect(
      verificationPolicyHash({
        verificationPolicy,
        environmentPolicy: { allowlist: ["NODE_ENV", "CI"], secretExceptions: [] },
      }),
    ).toBe(
      verificationPolicyHash({
        verificationPolicy,
        environmentPolicy: { allowlist: ["CI", "NODE_ENV"], secretExceptions: [] },
      }),
    );
  });
});
