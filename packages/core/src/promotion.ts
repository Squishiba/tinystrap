// Promotion broker (spec 9.10). The ONLY component that ever writes to the
// protected project or pushes a branch — always behind an explicit approve.
// Every git/gh invocation goes through the injectable CommandRunner so tests
// fake the remote-facing half entirely (no network, no real gh in CI).
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultCommandRunner, type CommandRunner } from "./run.js";
import { captureWorkspaceManifestHash, type Baseline } from "./snapshot-git.js";
import type { TaskHandle } from "./taskstore.js";

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

// Checkpoint = the exact undo set for one patch application: the list of
// paths the patch touches plus the current bytes of every touched file that
// exists (absent files are recorded as absent and deleted on restore). No
// reverse-apply trickery: restoring the touched files is exactly inverting
// the patch, because git apply only writes the paths it lists.
//
// The path list comes from the patch's own ---/+++ headers rather than from
// git: `git apply` has no --name-only (unlike `git diff`), and the header
// pair is what names BOTH sides of a rename, which is exactly the set the
// restore has to undo. Applicability stays git's judgement: `git apply
// --check` is the dry run, so a patch that would fail never gets a checkpoint.
function unquoteGitPath(raw: string): string {
  const p = raw.trim();
  if (p.startsWith('"') && p.endsWith('"')) return p.slice(1, -1);
  return p;
}

function patchTouchedPaths(patch: string): string[] {
  const paths = new Set<string>();
  for (const line of patch.split("\n")) {
    if (!line.startsWith("--- ") && !line.startsWith("+++ ")) continue;
    let rel = unquoteGitPath(line.slice(4));
    if (rel === "/dev/null") continue;
    if (rel.startsWith("a/") || rel.startsWith("b/")) rel = rel.slice(2);
    if (rel !== "") paths.add(rel);
  }
  return [...paths];
}

export async function createRollbackCheckpoint(
  projectRoot: string,
  handle: TaskHandle,
  patch: string,
  runner: CommandRunner = defaultCommandRunner,
): Promise<string> {
  const ckpt = join(handle.taskDir, "checkpoint");
  mkdirSync(ckpt, { recursive: true });
  const check = await runner("git", ["apply", "--check", "-"],
    { cwd: projectRoot, stdin: patch, timeoutMs: 60_000 });
  if (check.code !== 0) {
    throw new Error(`patch does not apply cleanly to the project: ${check.stderr || check.stdout}`);
  }
  const touched = patchTouchedPaths(patch);
  writeFileSync(join(ckpt, "touched.txt"), touched.join("\n") + "\n");
  for (const rel of touched) {
    const src = join(projectRoot, rel);
    if (existsSync(src)) {
      const dest = join(ckpt, "files", rel);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
    }
  }
  return ckpt;
}

export async function restoreFromCheckpoint(
  projectRoot: string,
  checkpointDir: string,
  _runner: CommandRunner = defaultCommandRunner,
): Promise<void> {
  const touched = readFileSync(join(checkpointDir, "touched.txt"), "utf8")
    .split("\n").map((l) => l.trim()).filter((l) => l !== "");
  for (const rel of touched) {
    const saved = join(checkpointDir, "files", rel);
    const target = join(projectRoot, rel);
    if (existsSync(saved)) copyFileSync(saved, target);
    else if (existsSync(target)) rmSync(target);
  }
}
