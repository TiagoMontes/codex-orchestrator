import { describe, expect, it } from "vitest";
import { redactRemoteUrl } from "../../../src/infrastructure/git/git-client.js";

describe("redactRemoteUrl", () => {
  it("removes HTTP credentials, tokens, and scp-style usernames", () => {
    expect(redactRemoteUrl("https://alice:secret@example.test/org/repo.git?token=hidden")).toBe(
      "https://example.test/org/repo.git",
    );
    expect(redactRemoteUrl("git@example.test:org/repo.git")).toBe("example.test:org/repo.git");
  });
});
