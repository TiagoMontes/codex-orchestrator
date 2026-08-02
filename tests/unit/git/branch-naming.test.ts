import { describe, expect, it } from "vitest";
import { taskBranchName } from "../../../src/infrastructure/git/branch-naming.js";

describe("taskBranchName", () => {
  it("creates a deterministic valid task branch", () => {
    expect(taskBranchName("BUG-2026-0001", "Fix Bêt route!!!")).toBe(
      "codex/BUG-2026-0001-fix-bet-route",
    );
  });
});
