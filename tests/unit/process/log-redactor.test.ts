import { describe, expect, it } from "vitest";
import { LogRedactor } from "../../../src/infrastructure/process/log-redactor.js";

describe("LogRedactor", () => {
  it("redacts credentials from common log forms", () => {
    const input = [
      "Authorization: Bearer abc.def.ghi",
      "API_TOKEN=top-secret",
      'payload={"password":"hunter2"}',
      "remote=https://alice:password@example.test/repo.git",
    ].join("\n");

    const redacted = new LogRedactor().redact(input);

    expect(redacted).not.toContain("abc.def.ghi");
    expect(redacted).not.toContain("top-secret");
    expect(redacted).not.toContain("hunter2");
    expect(redacted).not.toContain("alice:password");
    expect(redacted.match(/\[REDACTED\]/gu)?.length).toBeGreaterThanOrEqual(4);
  });
});
