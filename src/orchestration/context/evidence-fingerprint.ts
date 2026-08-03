import type { Evidence } from "../../domain/evidence/evidence.js";
import { sha256, stableJson } from "../../shared/hashing.js";

export function semanticEvidenceInput(item: Evidence): unknown {
  return {
    taskId: item.taskId,
    kind: item.kind,
    status: item.status,
    statement: item.statement,
    sourceCommit: item.sourceCommit,
    file: item.file ?? null,
    startLine: item.startLine ?? null,
    endLine: item.endLine ?? null,
    symbol: item.symbol ?? null,
    command: item.command ?? null,
    exitCode: item.exitCode ?? null,
    excerpt: item.excerpt ?? null,
    sha256: item.sha256 ?? null,
  };
}

export function semanticEvidenceId(prefix: string, item: Evidence): string {
  return `${prefix}-${sha256(stableJson(semanticEvidenceInput(item))).slice(0, 16)}`;
}
