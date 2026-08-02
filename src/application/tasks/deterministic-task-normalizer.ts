import type { TaskDraft, TaskType } from "../../domain/task/task.js";
import { taskDraftSchema } from "../../domain/task/task.js";
import type { TaskNormalizationRequest, TaskNormalizer } from "./task-normalizer.js";

export class DeterministicTaskNormalizer implements TaskNormalizer {
  normalize(request: TaskNormalizationRequest): Promise<TaskDraft> {
    const lines = request.originalFeedback.split(/\r?\n/u);
    const title = extractTitle(lines);
    const type = classifyTaskType(request.originalFeedback);
    const routeMatch = request.originalFeedback.match(
      /(?:^|\n)Route:\s*(?:(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+)?([^\s\n]+)/iu,
    );
    const methodMatch = request.originalFeedback.match(/(?:^|\n)Method:\s*([A-Z]+)/iu);
    const expected = extractSectionBullets(lines, "Expected behavior");
    const current = extractSectionText(lines, "Current behavior");
    const error = extractSectionText(lines, "Error");
    const constraints = extractConstraints(lines);
    const protectedContracts = lines
      .map((line) => line.replace(/^[-*]\s*/u, "").trim())
      .filter((line) => /(?:contract|public api).*(?:unchanged|preserv)/iu.test(line));
    const hypotheses = lines
      .map((line) => line.trim())
      .filter((line) => /^(?:suspected (?:cause|change)|hypothesis|i think)\s*:/iu.test(line));
    const acceptance = expected.length > 0 ? expected : [`Resolve the reported behavior: ${title}`];
    const riskSignals = detectRiskSignals(request.originalFeedback);

    return Promise.resolve(
      taskDraftSchema.parse({
        type,
        title,
        summary: current || firstParagraph(lines) || title,
        reports: [
          {
            id: "REPORT-001",
            title,
            ...(routeMatch?.[2] === undefined ? {} : { route: routeMatch[2] }),
            ...(routeMatch?.[1] === undefined && methodMatch?.[1] === undefined
              ? {}
              : { method: (routeMatch?.[1] ?? methodMatch?.[1])?.toUpperCase() }),
            currentBehavior: current,
            expectedBehavior: expected,
            payloads: [],
            observedResponses: [],
            errorMessages: error === "" ? [] : [error],
            stackTraces: extractFencedBlocks(request.originalFeedback),
            environment: {},
            suspectedChanges: hypotheses,
            reproductionNotes: [],
          },
        ],
        constraints,
        acceptanceCriteria: acceptance.map((statement, index) => ({
          id: `AC-${(index + 1).toString().padStart(3, "0")}`,
          statement,
          required: true,
          source: expected.length > 0 ? "user" : "inferred",
        })),
        protectedContracts,
        assumptions: hypotheses.map((statement) => ({
          statement,
          provenance: "user-hypothesis",
          status: "unverified",
        })),
        unknowns: error === "" ? ["The concrete failure mechanism has not been confirmed."] : [],
        riskSignals,
        suggestedScope: { included: [], excluded: [], estimatedFiles: [] },
        childTasks: [],
      }),
    );
  }
}

export function classifyTaskType(feedback: string): TaskType {
  const value = feedback.toLowerCase();
  if (/\b(audit|map architecture|business rules)\b/u.test(value)) return "audit";
  if (/\b(document|readme|docs)\b/u.test(value)) return "documentation";
  if (/\b(refactor|restructure|cleanup architecture)\b/u.test(value)) return "refactor";
  if (/\b(review|inspect diff)\b/u.test(value)) return "review";
  if (
    /\b(add tests?|test coverage)\b/u.test(value) &&
    !/\b(error|broken|bug|fail|500)\b/u.test(value)
  ) {
    return "test";
  }
  if (/\b(feature|add support|new capability)\b/u.test(value)) return "feature";
  if (/\b(investigate|unknown cause|research)\b/u.test(value)) return "investigation";
  if (/\b(error|broken|bug|fail|500|regression)\b/u.test(value)) return "bugfix";
  return "maintenance";
}

function extractTitle(lines: readonly string[]): string {
  const heading = lines.find((line) => /^#\s+\S/u.test(line));
  const candidate =
    heading?.replace(/^#\s+/u, "").trim() ?? lines.find((line) => line.trim() !== "")?.trim();
  return candidate?.slice(0, 160) || "Untitled task";
}

function extractSectionText(lines: readonly string[], section: string): string {
  const index = lines.findIndex(
    (line) => line.trim().toLowerCase() === `${section.toLowerCase()}:`,
  );
  if (index === -1) return "";
  const collected: string[] = [];
  for (let offset = index + 1; offset < lines.length; offset += 1) {
    const line = lines[offset];
    if (line === undefined) break;
    if (/^[A-Za-z][A-Za-z ]+:\s*$/u.test(line.trim()) || /^#\s/u.test(line)) break;
    if (line.trim() !== "") collected.push(line.trim());
  }
  return collected.join("\n");
}

function extractSectionBullets(lines: readonly string[], section: string): string[] {
  return extractSectionText(lines, section)
    .split("\n")
    .map((line) => line.replace(/^[-*]\s*/u, "").trim())
    .filter((line) => line !== "");
}

function extractConstraints(lines: readonly string[]): string[] {
  return lines
    .map((line) => line.replace(/^[-*]\s*/u, "").trim())
    .filter((line) =>
      /\b(must not|do not|without changing|remain unchanged|preserve)\b/iu.test(line),
    );
}

function firstParagraph(lines: readonly string[]): string {
  return lines
    .filter(
      (line) =>
        line.trim() !== "" && !line.startsWith("#") && !/^[A-Za-z][A-Za-z ]+:\s*$/u.test(line),
    )
    .slice(0, 3)
    .join(" ")
    .trim();
}

function extractFencedBlocks(feedback: string): string[] {
  return [...feedback.matchAll(/```[^\n]*\n([\s\S]*?)```/gu)]
    .map((match) => match[1] ?? "")
    .filter(Boolean);
}

export function detectRiskSignals(feedback: string): string[] {
  const signals: Array<[RegExp, string]> = [
    [/\b(authentication|authorization|permissions?)\b/iu, "authentication-or-authorization"],
    [/\b(payment|balance|prize|betting|financial)\b/iu, "financial-logic"],
    [/\b(personal data|sensitive data|pii)\b/iu, "sensitive-data"],
    [/\b(cryptography|encryption|signature)\b/iu, "cryptography"],
    [/\b(database schema|migration)\b/iu, "database-schema-or-migration"],
    [/\b(concurrency|race condition|deadlock)\b/iu, "concurrency"],
    [/\b(delete|destructive|truncate|drop table)\b/iu, "destructive-operation"],
    [/\b(public (?:api|response) contract|contract change)\b/iu, "public-contract"],
    [/\b(infrastructure|deployment)\b/iu, "infrastructure-or-deployment"],
    [/\b(cross-module|architectural refactor)\b/iu, "cross-module-architecture"],
  ];
  return signals.filter(([pattern]) => pattern.test(feedback)).map(([, label]) => label);
}
