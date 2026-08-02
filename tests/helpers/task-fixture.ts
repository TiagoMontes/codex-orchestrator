import type { Task } from "../../src/domain/task/task.js";

const timestamp = "2026-08-02T12:00:00.000Z";

export const routingTestTask: Task = {
  schemaVersion: 1,
  revision: 1,
  id: "BUG-2026-0001",
  projectId: "demo",
  childTaskIds: [],
  type: "bugfix",
  title: "Bug",
  summary: "Bug",
  originalFeedbackPath: "/tmp/original.md",
  profile: "balanced",
  risk: "medium",
  riskSignals: [],
  status: "ready-for-diagnosis",
  reports: [
    {
      id: "R1",
      title: "Bug",
      currentBehavior: "broken",
      expectedBehavior: ["fixed"],
      payloads: [],
      observedResponses: [],
      errorMessages: [],
      stackTraces: [],
      environment: {},
      suspectedChanges: [],
      reproductionNotes: [],
    },
  ],
  constraints: [],
  acceptanceCriteria: [{ id: "AC-1", statement: "fixed", required: true, source: "user" }],
  protectedContracts: [],
  assumptions: [],
  unknowns: [],
  requestedScope: { included: [], excluded: [], estimatedFiles: [] },
  createdAt: timestamp,
  updatedAt: timestamp,
};
