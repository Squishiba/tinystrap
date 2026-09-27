// WorkspaceProvider seam (spec 9.2). The default provider keeps the strong
// standalone guarantee: a fresh independent clone with no origin linkage.
// Signature note (plan open question 1): providers PRODUCE the Baseline —
// the spec's create(baseline) predates the code where snapshotting is what
// creates a baseline.
import { isGitProject, snapshotGit } from "./snapshot-git.js";
import { snapshotManifest } from "./snapshot-manifest.js";
import type { Baseline } from "./snapshot-git.js";
import type { TaskHandle } from "./taskstore.js";

export interface WorkspaceProvider {
  readonly id: "independent-clone" | "external";
  create(handle: TaskHandle, projectRoot: string,
    opts?: { allowIgnoredDirs?: string[] }): Promise<Baseline>;
  adopt(handle: TaskHandle, externalDir: string): Promise<Baseline>;
}

export function createIndependentCloneProvider(): WorkspaceProvider {
  return {
    id: "independent-clone",
    async create(handle, projectRoot, opts = {}) {
      return (await isGitProject(projectRoot))
        ? snapshotGit(projectRoot, handle, opts)
        : snapshotManifest(projectRoot, handle);
    },
    async adopt() {
      throw new Error("adopt is not supported by the independent-clone provider");
    },
  };
}
