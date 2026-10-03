// Promotion broker (spec 9.10). The ONLY component that ever writes to the
// protected project or pushes a branch — always behind an explicit approve.
// Every git/gh invocation goes through the injectable CommandRunner so tests
// fake the remote-facing half entirely (no network, no real gh in CI).
import { createHash } from "node:crypto";
import { defaultCommandRunner, type CommandRunner } from "./run.js";
import { captureWorkspaceManifestHash, type Baseline } from "./snapshot-git.js";

export type ProjectFingerprint = { revision: string; trackedChangesHash: string };

export async function computeProjectFingerprint(
  projectRoot: string,
  runner: CommandRunner = defaultCommandRunner,
): Promise<ProjectFingerprint> {
  const head = await runner("git", ["rev-parse", "HEAD"], { cwd: projectRoot, timeoutMs: 30_000 });
  if (head.code !== 0) throw new Error(`not a git project: ${head.stderr || head.stdout}`);
  const diff = await runner("git", ["diff", "HEAD"], { cwd: projectRoot, timeoutMs: 60_000 });
  return {
    revision: `git:${head.stdout.trim()}`,
    trackedChangesHash: `sha256:${createHash("sha256").update(diff.stdout).digest("hex")}`,
  };
}

// Spec 14 "Drift": promotion stops; the message offers rebase-or-review in
// terms a non-expert can act on. Rebase TOOLING is a follow-up (open question 6).
export async function checkDrift(
  projectRoot: string,
  baseline: Baseline,
  runner: CommandRunner = defaultCommandRunner,
): Promise<{ drifted: boolean; detail: string }> {
  if (!baseline.revision.startsWith("git:")) {
    const now = await captureWorkspaceManifestHash(projectRoot);
    return now === baseline.manifestHash
      ? { drifted: false, detail: "" }
      : { drifted: true, detail: "the project files changed since the task started" };
  }
  const fp = await computeProjectFingerprint(projectRoot, runner);
  if (fp.revision !== baseline.revision) {
    return { drifted: true, detail:
      "the project has new commits since the task started. Re-run the task on the current " +
      "state, or review and apply the patch by hand (tinystrap task export)." };
  }
  if (fp.trackedChangesHash !== baseline.trackedChangesHash) {
    return { drifted: true, detail:
      "uncommitted changes in the project changed since the task started. Review them " +
      "against the verified patch before applying anything." };
  }
  return { drifted: false, detail: "" };
}
