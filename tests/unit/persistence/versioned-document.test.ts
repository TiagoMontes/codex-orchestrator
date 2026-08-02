import { describe, expect, it } from "vitest";
import { z } from "zod";
import { VersionedDocumentParser } from "../../../src/infrastructure/persistence/versioned-document.js";

describe("VersionedDocumentParser", () => {
  it("applies a bounded explicit migration and validates the result", () => {
    const parser = new VersionedDocumentParser(
      2,
      z.object({ schemaVersion: z.literal(2), label: z.string() }).strict(),
      [
        {
          fromVersion: 1,
          toVersion: 2,
          migrate: (input) => {
            const old = z.object({ schemaVersion: z.literal(1), name: z.string() }).parse(input);
            return { schemaVersion: 2, label: old.name };
          },
        },
      ],
    );

    expect(parser.parse({ schemaVersion: 1, name: "migrated" })).toEqual({
      schemaVersion: 2,
      label: "migrated",
    });
  });

  it("rejects unsupported future versions", () => {
    const parser = new VersionedDocumentParser(
      1,
      z.object({ schemaVersion: z.literal(1) }).strict(),
    );

    expect(() => parser.parse({ schemaVersion: 2 })).toThrow("newer than supported");
  });
});
