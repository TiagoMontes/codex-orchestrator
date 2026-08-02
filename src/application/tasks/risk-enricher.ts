import type { RiskLevel } from "../../domain/task/task.js";

const CRITICAL_SIGNALS = new Set([
  "financial-logic",
  "cryptography",
  "destructive-operation",
  "database-schema-or-migration",
]);

export function enrichRisk(signals: readonly string[]): RiskLevel {
  if (signals.some((signal) => CRITICAL_SIGNALS.has(signal))) return "critical";
  if (signals.length > 0) return "high";
  return "medium";
}
