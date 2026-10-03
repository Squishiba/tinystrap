// Promotion broker (spec 9.10). The ONLY component that ever writes to the
// protected project or pushes a branch — always behind an explicit approve.
// Every git/gh invocation goes through the injectable CommandRunner so tests
// fake the remote-facing half entirely (no network, no real gh in CI).
import { createHash } from "node:crypto";
import { makeEvent, type HarnessEvent } from "@tinystrap/policy";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultCommandRunner, type CommandRunner, type RunResult } from "./run.js";
import { captureWorkspaceManifestHash, type Baseline } from "./snapshot-git.js";
import type { TaskHandle } from "./taskstore.js";
import { runVerifyCommand, type VerifyReport } from "./verify.js";
import type { VerifyCommand } from "./verify-commands.js";

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

// The guard is on the NAME, not the string as typed: a branch of "refs/heads/main"
// or "MAIN" reaches the same protected ref, and a leading "+" or a ":" turns the
// push refspec into a force push or a rewritten destination. So the allowed shape
// is a plain ref name, and protected names are refused after normalising both
// case and the refs/heads/ prefix. Returns an error message, or null when safe.
const TASK_BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
export function validateTaskBranch(branch: string): string | null {
  if (!TASK_BRANCH_PATTERN.test(branch) || branch.includes("..") || branch.endsWith("/")
    || branch.startsWith("refs/")) {
    return `invalid task branch name "${branch}": use letters, digits, . _ / - and do not ` +
      "start with a symbol or refs/";
  }
  const short = branch.replace(/^refs\/heads\//, "").toLowerCase();
  if (PROTECTED_BRANCHES.has(branch.toLowerCase()) || PROTECTED_BRANCHES.has(short)) {
    return `refusing to write to protected branch "${branch}"`;
  }
  return null;
}

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
  const invalid = validateTaskBranch(branch);
  if (invalid) return { ok: false, error: invalid };
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
  const invalid = validateTaskBranch(opts.branch);
  if (invalid) return { ok: false, stage: "branch", error: invalid };
  const committed = await commitTaskBranch(projectRoot, handle, patch, opts.branch, runner);
  if (!committed.ok) return { ok: false, stage: "branch", error: committed.error };

  const remote = await runner("git", ["remote", "get-url", "origin"],
    { cwd: projectRoot, timeoutMs: 30_000 });
  if (remote.code !== 0) {
    return { ok: false, stage: "remote",
      error: "the project has no origin remote to push to; configure one or use export_patch" };
  }
  // Fully qualified refspec: the destination can only ever be refs/heads/<branch>.
  const push = await runner("git", ["push", "origin",
    `refs/heads/${opts.branch}:refs/heads/${opts.branch}`], { cwd: projectRoot, timeoutMs: 120_000 });
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

export type PromotionMode = "apply" | "export_patch" | "commit_task_branch" | "open_pr";

// One-key approve with injected IO (same pattern as the init prompts): no
// readline, no TTY in tests. "y" (case-insensitive, trimmed) is the only
// affirmative; anything else is a denial — fail-safe by default.
export type ApproveIO = {
  out: (line: string) => void;
  ask: (question: string) => Promise<string>;
};

export type PromotionRequest = {
  handle: TaskHandle;
  baseline: Baseline;
  projectRoot: string;
  patch: string;
  report: VerifyReport;
  mode: PromotionMode;
  io: ApproveIO;
  runner?: CommandRunner;
  branch?: string;                       // default `tinystrap/<taskId>`
  prTitle?: string;
  prBody?: string;
  assumeYes?: boolean;                   // never satisfies open_pr (open question 4)
  postApplyCommands?: VerifyCommand[];   // default []; the CLI passes the resolved set
                                         // when promotion.postApplyVerify is true (oq 5)
  onEvent?: (e: HarnessEvent) => void;
};

export type PromotionOutcome =
  | { status: "applied"; checkpointDir: string; postApplyPassed: boolean | null }
  | { status: "exported"; destPath: string }
  | { status: "branch_committed"; branch: string; commit: string }
  | { status: "pr_opened"; branch: string; prUrl: string }
  | { status: "refused"; reason:
      "not_verified" | "approval_denied" | "drift" | "apply_failed" | "push_failed" | "error";
    message: string };

function isApproved(answer: string): boolean {
  return answer.trim().toLowerCase() === "y";
}

export async function promote(req: PromotionRequest): Promise<PromotionOutcome> {
  const runner = req.runner ?? defaultCommandRunner;
  const branch = req.branch ?? `tinystrap/${req.handle.taskId}`;
  const refuse = (reason: Extract<PromotionOutcome, { status: "refused" }>["reason"],
    message: string): PromotionOutcome => {
    req.onEvent?.(makeEvent(req.handle.taskId, "promotion_refused", { reason }));
    return { status: "refused", reason, message };
  };

  if (!req.report.passed) {
    return refuse("not_verified",
      "the patch did not pass verification, so nothing was promoted. Re-run the task, or " +
      "export the patch for a human: tinystrap task export " + req.handle.taskId);
  }

  // export_patch writes the patch into the project root without asking (open
  // question 7). That is a file write into the protected project, not "no side
  // effects": it is deliberate, but it is a side effect and should be revisited.
  if (req.mode === "export_patch") {
    const destPath = join(req.projectRoot, `${req.handle.taskId}.patch`);
    writeFileSync(destPath, req.patch);
    req.onEvent?.(makeEvent(req.handle.taskId, "promotion_applied",
      { decision: "export_patch", reason: destPath }));
    return { status: "exported", destPath };
  }

  // Refuse a bad branch before asking, so nobody approves a push that can't happen.
  if (req.mode === "open_pr" || req.mode === "commit_task_branch") {
    const invalid = validateTaskBranch(branch);
    if (invalid) return refuse("error", invalid);
  }

  // Show the diff (stat form) + the verification report, then one-key approve
  // (spec 9.10). For open_pr the prompt MUST name the branch that will be
  // pushed; --yes never satisfies a push (open question 4).
  const stat = await runner("git", ["apply", "--stat", "-"],
    { cwd: req.projectRoot, stdin: req.patch, timeoutMs: 30_000 });
  req.io.out(`Patch to promote (${req.mode}), verified ${req.report.patchHash.slice(0, 18)}…:`);
  req.io.out(stat.stdout.trim() || "(no stat available)");
  req.io.out(`Verification: ${req.report.results
    .map((r) => `${r.name}=${r.exitCode === 0 && !r.timedOut ? "PASS" : "FAIL"}`).join(" ")}`);

  const question = req.mode === "open_pr"
    ? `Push branch ${branch} to origin and open a pull request against main? [y/N] `
    : req.mode === "commit_task_branch"
      ? `Commit this patch to new branch ${branch} (no push)? [y/N] `
      : "Apply this patch to your project? [y/N] ";
  req.onEvent?.(makeEvent(req.handle.taskId, "promotion_requested",
    { decision: req.mode, reason: `branch=${branch}` }));

  const approved = req.mode === "open_pr"
    ? isApproved(await req.io.ask(question))                 // interactive only, always
    : (req.assumeYes === true || isApproved(await req.io.ask(question)));
  if (!approved) {
    return refuse("approval_denied", "you declined; nothing was changed. The verified patch is " +
      `still available: tinystrap task export ${req.handle.taskId}`);
  }

  const drift = await checkDrift(req.projectRoot, req.baseline, runner);
  if (drift.drifted) {
    return refuse("drift", `promotion stopped: ${drift.detail}`);
  }

  if (req.mode === "apply") {
    // The exact bytes that were verified — never a re-extraction, never a
    // directory copy (spec 9.10).
    const checkpointDir = await createRollbackCheckpoint(req.projectRoot, req.handle, req.patch, runner);
    const applied = await applyPatchToProject(req.projectRoot, req.patch, runner);
    if (applied.code !== 0) {
      return refuse("apply_failed", "the verified patch did not apply cleanly; nothing was " +
        `changed. Export it for review: tinystrap task export ${req.handle.taskId}`);
    }
    let postApplyPassed: boolean | null = null;
    const post = req.postApplyCommands ?? [];
    if (post.length > 0) {
      postApplyPassed = true;
      for (const cmd of post) {
        const r = await runVerifyCommand(cmd, req.projectRoot, { runner });
        if (r.exitCode !== 0 || r.timedOut) { postApplyPassed = false; break; }
      }
      if (!postApplyPassed) {
        await restoreFromCheckpoint(req.projectRoot, checkpointDir, runner);
        return refuse("apply_failed", "post-apply checks failed, so the project was restored " +
          "to its pre-promotion state. Export the patch and inspect the check output.");
      }
    }
    req.onEvent?.(makeEvent(req.handle.taskId, "promotion_applied", { decision: "apply" }));
    return { status: "applied", checkpointDir, postApplyPassed };
  }

  if (req.mode === "commit_task_branch") {
    const committed = await commitTaskBranch(req.projectRoot, req.handle, req.patch, branch, runner);
    if (!committed.ok) {
      return refuse("error", `could not create the task branch: ${committed.error}`);
    }
    req.onEvent?.(makeEvent(req.handle.taskId, "promotion_applied",
      { decision: "commit_task_branch", reason: branch }));
    return { status: "branch_committed", branch, commit: committed.commit };
  }

  // open_pr — reached only through the interactive approve above.
  const pr = await openPullRequest(req.projectRoot, req.handle, req.patch,
    { branch, title: req.prTitle, body: req.prBody, runner });
  if (!pr.ok) {
    return refuse(pr.stage === "push" ? "push_failed" : "error", pr.error);
  }
  req.onEvent?.(makeEvent(req.handle.taskId, "promotion_applied",
    { decision: "open_pr", reason: pr.prUrl }));
  return { status: "pr_opened", branch: pr.branch, prUrl: pr.prUrl };
}
