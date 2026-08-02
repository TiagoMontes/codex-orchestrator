import { z } from "zod";
import { OrchestratorError } from "../../shared/errors.js";

export const readWorkstreamSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u),
    objective: z.string().min(1),
    scopeKeys: z.array(z.string().min(1)).min(1),
    relevantFiles: z.array(z.string()),
    depth: z.literal(1),
  })
  .strict();

export type ReadWorkstream = z.infer<typeof readWorkstreamSchema>;

export type WorkstreamPlan =
  | { mode: "serial"; workstreams: ReadWorkstream[]; reason: string }
  | { mode: "parallel"; workstreams: ReadWorkstream[]; reason: string };

export class WorkstreamPartitioner {
  partition(candidates: readonly ReadWorkstream[], maximumReaders: number): WorkstreamPlan {
    const workstreams = candidates.map((candidate) => readWorkstreamSchema.parse(candidate));
    if (workstreams.length <= 1) {
      return {
        mode: "serial",
        workstreams,
        reason: "A localized task does not benefit from readers",
      };
    }
    if (maximumReaders < 2) {
      return {
        mode: "serial",
        workstreams,
        reason: "The selected profile allows fewer than two readers",
      };
    }
    if (workstreams.length > maximumReaders) {
      throw new OrchestratorError(
        `Requested ${workstreams.length} readers but the profile allows ${maximumReaders}`,
        { code: "BUDGET", resumable: true },
      );
    }
    assertIndependentWorkstreams(workstreams);
    return {
      mode: "parallel",
      workstreams,
      reason: "Scopes are disjoint and can be inspected independently",
    };
  }
}

export function assertIndependentWorkstreams(workstreams: readonly ReadWorkstream[]): void {
  const ids = new Set<string>();
  const owners = new Map<string, string>();
  for (const workstream of workstreams) {
    if (ids.has(workstream.id)) {
      throw new OrchestratorError(`Duplicate read-workstream ID: ${workstream.id}`, {
        code: "CONFIGURATION",
      });
    }
    ids.add(workstream.id);
    for (const scope of workstream.scopeKeys) {
      const normalized = normalizeScope(scope);
      for (const [existing, owner] of owners) {
        if (scopesOverlap(existing, normalized)) {
          throw new OrchestratorError(
            `Read workstreams ${owner} and ${workstream.id} overlap on scopes ${existing} and ${normalized}`,
            { code: "CONFIGURATION" },
          );
        }
      }
      owners.set(normalized, workstream.id);
    }
  }
}

function normalizeScope(scope: string): string {
  return scope.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, "");
}

function scopesOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}
