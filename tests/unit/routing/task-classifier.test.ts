import { describe, expect, it } from "vitest";
import { TaskClassifier } from "../../../src/orchestration/routing/task-classifier.js";
import { routingTestTask } from "../../helpers/task-fixture.js";

describe("TaskClassifier", () => {
  it("keeps a localized single report serial", () => {
    expect(new TaskClassifier().classify(routingTestTask)).toMatchObject({
      scopeEstimate: "localized",
      recommendedParallelReaders: 0,
    });
  });

  it("recommends bounded readers only for independent reports", () => {
    const report = routingTestTask.reports[0];
    if (report === undefined) throw new Error("fixture report missing");
    const result = new TaskClassifier().classify({
      ...routingTestTask,
      reports: [report, { ...report, id: "R2" }, { ...report, id: "R3" }],
      requestedScope: { included: ["a", "b"], excluded: [], estimatedFiles: ["a", "b", "c", "d"] },
    });
    expect(result.recommendedParallelReaders).toBe(3);
    expect(result.scopeEstimate).toBe("module");
  });
});
