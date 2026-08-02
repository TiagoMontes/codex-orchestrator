import type { Task } from "../../domain/task/task.js";

export type TaskClassification = {
  complexity: "simple" | "standard" | "complex";
  ambiguity: "low" | "medium" | "high";
  riskDomains: string[];
  scopeEstimate: "localized" | "module" | "cross-module";
  independentReports: number;
  recommendedParallelReaders: number;
  signals: string[];
};

export class TaskClassifier {
  classify(task: Task): TaskClassification {
    const estimatedFiles = task.requestedScope.estimatedFiles.length;
    const independentReports = task.reports.length;
    const riskDomains = [...new Set(task.riskSignals)];
    const unresolved =
      task.unknowns.length + task.assumptions.filter((item) => item.status === "unverified").length;
    const scopeEstimate =
      estimatedFiles > 8 || riskDomains.includes("cross-module-architecture")
        ? "cross-module"
        : estimatedFiles > 3 || independentReports > 1
          ? "module"
          : "localized";
    const ambiguity = unresolved > 3 ? "high" : unresolved > 0 ? "medium" : "low";
    const complexity =
      task.risk === "critical" || scopeEstimate === "cross-module" || ambiguity === "high"
        ? "complex"
        : task.risk === "low" && scopeEstimate === "localized" && ambiguity === "low"
          ? "simple"
          : "standard";
    const independent = independentReports > 1 && scopeEstimate !== "localized";
    const recommendedParallelReaders = independent ? Math.min(independentReports, 3) : 0;
    const signals = [
      `complexity:${complexity}`,
      `ambiguity:${ambiguity}`,
      `scope:${scopeEstimate}`,
      `reports:${independentReports}`,
      ...riskDomains.map((domain) => `risk:${domain}`),
    ];
    return {
      complexity,
      ambiguity,
      riskDomains,
      scopeEstimate,
      independentReports,
      recommendedParallelReaders,
      signals,
    };
  }
}
