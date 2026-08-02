import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseStructuredOutput } from "../../../src/infrastructure/codex/codex-output-parser.js";

describe("parseStructuredOutput", () => {
  const schema = z.object({ answer: z.string() }).strict();

  it("parses and strictly validates JSON", () => {
    expect(parseStructuredOutput('{"answer":"ok"}', schema)).toEqual({ answer: "ok" });
  });

  it("rejects invalid JSON and unexpected properties", () => {
    expect(() => parseStructuredOutput("not json", schema)).toThrow("not valid JSON");
    expect(() => parseStructuredOutput('{"answer":"ok","extra":true}', schema)).toThrow(
      "failed runtime validation",
    );
  });
});
