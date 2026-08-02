import { describe, expect, it } from "vitest";
import { formatTaskId, taskCounterKey } from "../../../src/shared/ids.js";

describe("task IDs", () => {
  it("uses stable type prefixes and UTC-year sequences", () => {
    expect(taskCounterKey("bugfix", 2026)).toBe("BUG-2026");
    expect(formatTaskId("bugfix", 2026, 1)).toBe("BUG-2026-0001");
    expect(formatTaskId("documentation", 2026, 42)).toBe("DOC-2026-0042");
  });

  it("rejects invalid sequence values", () => {
    expect(() => formatTaskId("feature", 2026, 0)).toThrow(RangeError);
  });
});
