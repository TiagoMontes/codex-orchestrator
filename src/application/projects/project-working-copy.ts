import type { Project } from "../../domain/project/project.js";
import { ProjectMetadataScanner } from "./project-metadata-scanner.js";
import { StackDetector } from "./stack-detector.js";

/** Rebinds commit-scoped project metadata to the exact tree used by an agent phase. */
export async function projectAtWorkingRoot(
  project: Project,
  workingRoot: string,
  sourceCommit: string,
): Promise<Project> {
  const [{ stack }, metadata] = await Promise.all([
    new StackDetector().detect(workingRoot),
    new ProjectMetadataScanner().scan(workingRoot),
  ]);
  const { currentBranch: ignoredBranch, ...stableProject } = project;
  void ignoredBranch;
  return {
    ...stableProject,
    repositoryPath: workingRoot,
    gitRoot: workingRoot,
    currentHeadCommit: sourceCommit,
    detectedStack: stack,
    instructionFiles: metadata.instructionFiles,
    skillMetadata: metadata.skillMetadata,
  };
}
