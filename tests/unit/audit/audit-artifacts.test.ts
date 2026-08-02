import { describe, expect, it } from "vitest";
import {
  auditAgentResultSchema,
  businessRuleSchema,
} from "../../../src/domain/audit/audit-artifacts.js";

describe("audit artifact schemas", () => {
  it("requires evidence or explicit uncertainty for every business rule", () => {
    expect(() =>
      businessRuleSchema.parse({
        id: "BR-1",
        domain: "bets",
        statement: "A bet returns its public response contract",
        confidence: "high",
        evidenceIds: [],
        relatedRoutes: ["POST /bet"],
        relatedSymbols: ["placeBet"],
        exceptions: [],
        unknowns: [],
      }),
    ).toThrow(/evidence or uncertainty/u);
  });

  it("rejects arbitrary agent chatter fields", () => {
    expect(() =>
      auditAgentResultSchema.parse({
        schemaVersion: 1,
        projectId: "demo",
        sourceCommit: "abc",
        repositoryMap: { summary: "map", modules: [], entryPoints: [], unknowns: [] },
        architecture: { summary: "architecture", components: [], relationships: [], unknowns: [] },
        businessRules: { rules: [], unknowns: [] },
        verification: { summary: "verification", strategies: [], unknowns: [] },
        risks: { summary: "risks", risks: [], unknowns: [] },
        evidenceReferences: [],
        rawChatter: "not allowed",
      }),
    ).toThrow();
  });
});
