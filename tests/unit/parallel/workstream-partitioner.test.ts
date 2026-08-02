import { describe, expect, it } from "vitest";
import {
  WorkstreamPartitioner,
  assertIndependentWorkstreams,
  type ReadWorkstream,
} from "../../../src/orchestration/parallel/workstream-partitioner.js";

function stream(id: string, scope: string): ReadWorkstream {
  return {
    id,
    objective: `Inspect ${scope}`,
    scopeKeys: [scope],
    relevantFiles: [scope],
    depth: 1,
  };
}

describe("WorkstreamPartitioner", () => {
  it("parallelizes only independent scopes", () => {
    const plan = new WorkstreamPartitioner().partition(
      [stream("frontend", "src/frontend"), stream("backend", "src/backend")],
      2,
    );

    expect(plan.mode).toBe("parallel");
    expect(plan.workstreams).toHaveLength(2);
  });

  it("keeps localized work serial", () => {
    expect(new WorkstreamPartitioner().partition([stream("one", "src")], 2)).toMatchObject({
      mode: "serial",
    });
    expect(
      new WorkstreamPartitioner().partition(
        [stream("frontend", "src/frontend"), stream("backend", "src/backend")],
        1,
      ),
    ).toMatchObject({ mode: "serial" });
  });

  it("rejects exact and parent-child scope overlap", () => {
    expect(() =>
      assertIndependentWorkstreams([stream("one", "src/api"), stream("two", "./src/api/")]),
    ).toThrow(/overlap/u);
    expect(() =>
      assertIndependentWorkstreams([
        stream("parent", "src/api"),
        stream("child", "src/api/routes"),
      ]),
    ).toThrow(/overlap/u);
  });

  it("rejects duplicate worker identities and excess readers", () => {
    expect(() =>
      assertIndependentWorkstreams([stream("same", "src/a"), stream("same", "src/b")]),
    ).toThrow(/Duplicate/u);
    expect(() =>
      new WorkstreamPartitioner().partition(
        [stream("one", "src/a"), stream("two", "src/b"), stream("three", "src/c")],
        2,
      ),
    ).toThrow(/allows 2/u);
  });
});
