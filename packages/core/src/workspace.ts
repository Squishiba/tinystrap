// WorkspaceProvider seam (spec 9.2). The default provider keeps the strong
// standalone guarantee: a fresh independent clone with no origin linkage.
// Signature note (plan open question 1): providers PRODUCE the Baseline —
// the spec's create(baseline) predates the code where snapshotting is what
// creates a baseline.
import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isGitProject, snapshotGit, captureWorkspaceManifestHash } from "./snapshot-git.js";
import { snapshotManifest } from "./snapshot-manifest.js";
import { runGit } from "./git.js";
import type { Baseline } from "./snapshot-git.js";
import type { ResolvedConfig } from "./config.js";
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

// External provider (spec 9.2, 13.5 mode 3): the host — a Paseo worker, a git
// worktree — already owns the directory. The harness does NOT copy it and
// does NOT own its lifecycle; it records a baseline from the directory's own
// git state and points the handle at it. Git-metadata isolation is NOT
// structural here (spec table): policy + the promotion broker are the guard.
// v1 requires the adopted directory to be a git repo (patch extraction is
// git-only — plan open question 3).
export function createExternalWorkspaceProvider(): WorkspaceProvider {
  return {
    id: "external",
    async create() {
      throw new Error("the external provider never creates workspaces; use adopt()");
    },
    async adopt(handle, externalDir) {
      const probe = await runGit(externalDir, ["rev-parse", "--git-dir"]);
      if (probe.code !== 0) {
        throw new Error(`adopted workspace is not a git repository: ${externalDir} ` +
          `(external workspaces need git for patch extraction)`);
      }
      const head = await runGit(externalDir, ["rev-parse", "HEAD"]);
      if (head.code !== 0) {
        throw new Error(`adopted workspace has no commits yet: ${externalDir}`);
      }
      const diff = await runGit(externalDir, ["diff", "HEAD"]);
      const baseline: Baseline = {
        taskId: handle.taskId,
        sourceRoot: externalDir,
        revision: `git:${head.stdout.trim()}`,
        manifestHash: await captureWorkspaceManifestHash(externalDir),
        trackedChangesHash: `sha256:${createHash("sha256").update(diff.stdout).digest("hex")}`,
        untrackedPolicy: "external:host-owned",
        createdAt: new Date().toISOString(),
      };
      writeFileSync(handle.baselinePath, JSON.stringify(baseline, null, 2));
      writeFileSync(join(handle.taskDir, "external.json"),
        JSON.stringify({ dir: externalDir }, null, 2));
      handle.externalWorkspaceDir = externalDir;
      return baseline;
    },
  };
}

// Spec 7: the [workspace] table selects the provider; external demands a
// path. Unknown names fail loudly — silently falling back to the default
// would hide a typo behind a full re-clone of the wrong tree.
export function workspaceProviderFromConfig(config: ResolvedConfig): WorkspaceProvider {
  const provider = String(config["workspace.provider"]?.value ?? "independent-clone");
  if (provider === "independent-clone") return createIndependentCloneProvider();
  if (provider === "external") {
    const path = config["workspace.path"]?.value;
    if (typeof path !== "string" || path.trim() === "") {
      throw new Error("workspace.path is required when workspace.provider = \"external\"");
    }
    if (!existsSync(path)) {
      throw new Error(`workspace.path does not exist: ${path}`);
    }
    return createExternalWorkspaceProvider();
  }
  throw new Error(`unknown workspace provider "${provider}" (expected independent-clone or external)`);
}
