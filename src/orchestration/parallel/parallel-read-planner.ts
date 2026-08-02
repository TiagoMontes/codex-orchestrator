import type { Task } from "../../domain/task/task.js";
import { OrchestratorError } from "../../shared/errors.js";
import {
  WorkstreamPartitioner,
  type ReadWorkstream,
  type WorkstreamPlan,
} from "./workstream-partitioner.js";

export type ParallelReadScope = {
  id: string;
  objective: string;
  relevantFiles: string[];
};

export function planParallelReads(input: {
  task: Task;
  requestedReaders: number;
  maximumReaders: number;
  scopes?: ParallelReadScope[];
}): WorkstreamPlan {
  if (input.requestedReaders < 2) {
    return {
      mode: "serial",
      workstreams: [],
      reason: "the task is localized or fewer than two readers were requested",
    };
  }
  const readerCount = Math.min(input.requestedReaders, input.maximumReaders);
  if (readerCount < 2) {
    return {
      mode: "serial",
      workstreams: [],
      reason: "the selected profile permits fewer than two readers",
    };
  }
  const declaredScopes = input.scopes?.filter((scope) => scope.objective.trim() !== "") ?? [];
  let candidates: ReadWorkstream[];
  if (declaredScopes.length >= 2) {
    candidates = declaredScopes.slice(0, readerCount).map((scope, index) => ({
      id: `scope-${index + 1}`,
      objective: scope.objective,
      scopeKeys:
        scope.relevantFiles.length > 0 ? scope.relevantFiles : [`declared-scope-${scope.id}`],
      relevantFiles: scope.relevantFiles,
      depth: 1,
    }));
  } else if (input.task.reports.length >= 2) {
    const reports = input.task.reports.slice(0, readerCount);
    candidates = reports.map((report, index) => ({
      id: `report-${index + 1}`,
      objective: `Independently inspect report ${report.id}: ${report.title}`,
      scopeKeys: [`report-${report.id}`],
      relevantFiles: input.task.requestedScope.estimatedFiles.filter(
        (_file, fileIndex) => fileIndex % reports.length === index,
      ),
      depth: 1,
    }));
  } else if (input.task.requestedScope.estimatedFiles.length >= 2) {
    candidates = input.task.requestedScope.estimatedFiles
      .slice(0, readerCount)
      .map((file, index) => ({
        id: `file-${index + 1}`,
        objective: `Independently inspect ${file} for evidence relevant to ${input.task.title}`,
        scopeKeys: [file],
        relevantFiles: [file],
        depth: 1,
      }));
  } else {
    return {
      mode: "serial",
      workstreams: [],
      reason: "no independent reports or disjoint file scopes were available",
    };
  }
  try {
    return new WorkstreamPartitioner().partition(candidates, readerCount);
  } catch (error) {
    if (error instanceof OrchestratorError && error.code === "CONFIGURATION") {
      return {
        mode: "serial",
        workstreams: candidates,
        reason: "candidate workstreams overlap and must be inspected serially",
      };
    }
    throw error;
  }
}
