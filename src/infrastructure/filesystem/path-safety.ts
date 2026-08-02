import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { OrchestratorError } from "../../shared/errors.js";

export type SafePathOptions = {
  allowMissing?: boolean;
};

export async function resolveSafePath(
  root: string,
  candidate: string,
  options: SafePathOptions = {},
): Promise<string> {
  rejectParentSegments(candidate);
  const absoluteRoot = resolve(root);
  const absoluteCandidate = isAbsolute(candidate)
    ? resolve(candidate)
    : resolve(absoluteRoot, candidate);
  assertLexicallyContained(absoluteRoot, absoluteCandidate);

  const canonicalRoot = await realpath(absoluteRoot).catch((error: unknown) => {
    throw new OrchestratorError(`Allowed root does not exist: ${absoluteRoot}`, {
      code: "PROJECT",
      cause: error,
    });
  });

  try {
    const canonicalCandidate = await realpath(absoluteCandidate);
    assertCanonicallyContained(canonicalRoot, canonicalCandidate);
    return canonicalCandidate;
  } catch (error) {
    if (!(options.allowMissing ?? false) || !isMissingPathError(error)) {
      if (error instanceof OrchestratorError) {
        throw error;
      }
      throw new OrchestratorError(
        `Path does not exist or cannot be resolved: ${absoluteCandidate}`,
        {
          code: "PROJECT",
          cause: error,
        },
      );
    }
  }

  const existingAncestor = await nearestExistingAncestor(absoluteCandidate, absoluteRoot);
  const canonicalAncestor = await realpath(existingAncestor);
  assertCanonicallyContained(canonicalRoot, canonicalAncestor);
  return resolve(canonicalRoot, relative(absoluteRoot, absoluteCandidate));
}

export async function canonicalizeExistingPath(path: string): Promise<string> {
  try {
    return await realpath(resolve(path));
  } catch (error) {
    throw new OrchestratorError(`Path does not exist or cannot be resolved: ${path}`, {
      code: "PROJECT",
      cause: error,
    });
  }
}

function rejectParentSegments(path: string): void {
  if (path.split(/[\\/]/u).includes("..")) {
    throw new OrchestratorError(`Parent path segments are not allowed: ${path}`, {
      code: "PROJECT",
    });
  }
}

function assertLexicallyContained(root: string, candidate: string): void {
  if (!isContained(root, candidate)) {
    throw new OrchestratorError(`Path escapes allowed root: ${candidate}`, { code: "PROJECT" });
  }
}

function assertCanonicallyContained(root: string, candidate: string): void {
  if (!isContained(root, candidate)) {
    throw new OrchestratorError(`Resolved path escapes allowed root: ${candidate}`, {
      code: "PROJECT",
    });
  }
}

function isContained(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return (
    difference === "" ||
    (!difference.startsWith(`..${sep}`) && difference !== ".." && !isAbsolute(difference))
  );
}

async function nearestExistingAncestor(candidate: string, root: string): Promise<string> {
  let current = dirname(candidate);
  const maximumChecks = candidate.split(sep).length + 1;
  for (let check = 0; check < maximumChecks; check += 1) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
    }
    if (current === root || dirname(current) === current) {
      break;
    }
    current = dirname(current);
  }
  throw new OrchestratorError(`No existing parent found inside allowed root for ${candidate}`, {
    code: "PROJECT",
  });
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
