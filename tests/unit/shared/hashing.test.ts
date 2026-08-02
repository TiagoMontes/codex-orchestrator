import { describe, expect, it } from "vitest";
import { hashJson } from "../../../src/shared/hashing.js";

describe("hashJson", () => {
  it("is stable across object key insertion order", () => {
    expect(hashJson({ b: 2, a: { d: 4, c: 3 } })).toBe(hashJson({ a: { c: 3, d: 4 }, b: 2 }));
  });
});
