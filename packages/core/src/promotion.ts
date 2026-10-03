// Promotion broker (spec 9.10). The ONLY component that ever writes to the
// protected project or pushes a branch — always behind an explicit approve.
// Every git/gh invocation goes through the injectable CommandRunner so tests
// fake the remote-facing half entirely (no network, no real gh in CI).
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultCommandRunner, type CommandRunner, type RunResult } from "./run.js";
import { captureWorkspaceManifestHash, type Baseline } from "./snapshot-git.js";
import type { TaskHandle } from "./taskstore.js";

export type ProjectFingerprint = { revision: string; trackedChangesHash: string };

// Identity for plumbing commits (open question 9): never the user's git
// config, and a .invalid address so no real mailbox appears in a public repo.
const HARNESS_IDENTITY = "tinystrap";
const HARNESS_IDENTITY_EMAIL = "tinystrap@tinystrap.invalid";

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

export const PROTECTED_BRANCHES: ReadonlySet<string> = new Set(["main", "master"]);

export type CommitBranchResult =
  | { ok: true; commit: string }
  | { ok: false; error: string };

// Spec 9.10 step (3): apply ONLY the exact verified patch bytes, via stdin,
// never a directory copy. git apply is atomic: a failed apply changes nothing.
export async function applyPatchToProject(
  projectRoot: string, patch: string, runner: CommandRunner = defaultCommandRunner,
): Promise<RunResult> {
  return runner("git", ["apply", "--whitespace=nowarn", "-"],
    { cwd: projectRoot, stdin: patch, timeoutMs: 60_000 });
}

// commit_task_branch: pure git plumbing (temp index -> read-tree -> apply
// --cached -> write-tree -> commit-tree -> update-ref). The user's working tree,
// index, and HEAD are never touched, and no push happens. Harness identity
// env keeps machines without a configured identity working (open question 9);
// the user's own git config is never read for authorship or modified.
export async function commitTaskBranch(
  projectRoot: string,
  handle: TaskHandle,
  patch: string,
  branch: string,
  runner: CommandRunner = defaultCommandRunner,
): Promise<CommitBranchResult> {
  if (PROTECTED_BRANCHES.has(branch)) {
    return { ok: false, error: `refusing to write to protected branch "${branch}"` };
  }
  const exists = await runner("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
    { cwd: projectRoot, timeoutMs: 30_000 });
  if (exists.code === 0) {
    return { ok: false, error: `branch "${branch}" already exists; refusing to move it` };
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_INDEX_FILE: join(handle.taskDir, "branch.index"),
    GIT_AUTHOR_NAME: HARNESS_IDENTITY, GIT_AUTHOR_EMAIL: HARNESS_IDENTITY_EMAIL,
    GIT_COMMITTER_NAME: HARNESS_IDENTITY, GIT_COMMITTER_EMAIL: HARNESS_IDENTITY_EMAIL,
  };
  const read = await runner("git", ["read-tree", "HEAD"], { cwd: projectRoot, env, timeoutMs: 60_000 });
  if (read.code !== 0) return { ok: false, error: `read-tree failed: ${read.stderr || read.stdout}` };
  const applied = await runner("git", ["apply", "--cached", "--whitespace=nowarn", "-"],
    { cwd: projectRoot, env, stdin: patch, timeoutMs: 60_000 });
  if (applied.code !== 0) {
    return { ok: false, error: `patch does not apply to the project: ${applied.stderr || applied.stdout}` };
  }
  const tree = await runner("git", ["write-tree"], { cwd: projectRoot, env, timeoutMs: 60_000 });
  if (tree.code !== 0) return { ok: false, error: `write-tree failed: ${tree.stderr || tree.stdout}` };
  const commit = await runner("git", ["commit-tree", tree.stdout.trim(), "-m",
    `tinystrap: verified task patch ${handle.taskId}`], { cwd: projectRoot, env, timeoutMs: 60_000 });
  if (commit.code !== 0) {
    return { ok: false, error: `commit-tree failed: ${commit.stderr || commit.stdout}` };
  }
  const ref = await runner("git", ["update-ref", `refs/heads/${branch}`, commit.stdout.trim()],
    { cwd: projectRoot, env, timeoutMs: 30_000 });
  if (ref.code !== 0) {
    return { ok: false, error: `update-ref failed: ${ref.stderr || ref.stdout}` };
  }
  return { ok: true, commit: commit.stdout.trim() };
}

// open_pr (spec 9.10): the broker — never the model — pushes ONLY the task
// branch and opens a PR. Guards live here so no caller can construct an
// unsafe push by accident: protected names are refused before any process
// runs; the push command is a fixed refspec with no force flag in the
// vocabulary; gh runs only after a successful push. All remote contact goes
// through the injected runner — production uses defaultCommandRunner, tests
// use a recorder, CI never touches a network.
export type OpenPrResult =
  | { ok: true; branch: string; prUrl: string }
  | { ok: false; stage: "branch" | "remote" | "push" | "pr"; error: string };

export async function openPullRequest(
  projectRoot: string,
  handle: TaskHandle,
  patch: string,
  opts: { branch: string; base?: string; title?: string; body?: string;
    runner?: CommandRunner },
): Promise<OpenPrResult> {
  const runner = opts.runner ?? defaultCommandRunner;
  if (PROTECTED_BRANCHES.has(opts.branch)) {
    return { ok: false, stage: "branch",
      error: `refusing to push protected branch "${opts.branch}"` };
  }
  const committed = await commitTaskBranch(projectRoot, handle, patch, opts.branch, runner);
  if (!committed.ok) return { ok: false, stage: "branch", error: committed.error };

  const remote = await runner("git", ["remote", "get-url", "origin"],
    { cwd: projectRoot, timeoutMs: 30_000 });
  if (remote.code !== 0) {
    return { ok: false, stage: "remote",
      error: "the project has no origin remote to push to; configure one or use export_patch" };
  }
  const push = await runner("git", ["push", "origin",
    `${opts.branch}:${opts.branch}`], { cwd: projectRoot, timeoutMs: 120_000 });
  if (push.code !== 0) {
    return { ok: false, stage: "push", error: `push failed: ${push.stderr || push.stdout}` };
  }
  const gh = await runner("gh", ["pr", "create",
    "--head", opts.branch, "--base", opts.base ?? "main",
    "--title", opts.title ?? `tinystrap: ${handle.taskId}`,
    "--body", opts.body ?? `Verified task patch for ${handle.taskId}.`],
    { cwd: projectRoot, timeoutMs: 120_000 });
  if (gh.code !== 0) {
    return { ok: false, stage: "pr", error: `gh pr create failed: ${gh.stderr || gh.stdout}` };
  }
  const prUrl = gh.stdout.trim().split("\n").find((l) => l.startsWith("http")) ?? "";
  return { ok: true, branch: opts.branch, prUrl };
}
