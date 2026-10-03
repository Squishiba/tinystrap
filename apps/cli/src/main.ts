import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  createTask, destroyTask, exportPatch, extractPatch, openTask, runDoctor,
  snapshotGit, isGitProject, snapshotManifest,
} from "@tinystrap/core";
// Second import block on purpose: keeps this file's diff additive while the
// init-CLI group edits the same import list in parallel.
import {
  detectVerifyCommands, loadConfig, promote, resolveVerifyCommands,
  verifyInFreshWorkspace, verifyOverridesFromConfig,
  type ApproveIO, type Baseline, type PromotionMode, type ResolvedConfig,
  type VerifyCommand, type VerifyReport,
} from "@tinystrap/core";
import { Discovery, StubDiscovery } from "@tinystrap/discovery";
import { runInit } from "./init.js";

// The ONLY place this repo reads a terminal. Used by the `init` branch below
// alone - `core` takes an injected PromptIO, and no test ever calls this.
async function askOnTerminal(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(question)).trim(); } finally { rl.close(); }
}

// Set by the `init` branch only. `init` is the one command with an exit-code
// contract (see flags.ts); every other branch keeps today's string return and the
// existing throw-to-exit-1 behavior.
let initExitCode: number | undefined;

const PROMOTION_MODES: readonly PromotionMode[] =
  ["apply", "export_patch", "commit_task_branch", "open_pr"];

function flagValue(argv: string[], flag: string, fallback: string): string {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

// Verify commands come from detection plus the [verify] config table, never
// from free-form CLI text (spec 9.9): the CLI offers no "run this command"
// flag at all.
function resolvedVerifyCommands(
  projectRoot: string, config: ResolvedConfig,
): VerifyCommand[] {
  return resolveVerifyCommands(
    detectVerifyCommands(projectRoot), verifyOverridesFromConfig(config));
}

export function formatVerifyReport(r: VerifyReport): string {
  const lines = [`${r.taskId}: ${r.passed ? "PASS" : "FAIL"} `
    + `(${r.results.length} checks, patch ${r.patchHash.slice(0, 18)}…)`];
  if (!r.apply.ok) {
    lines.push(`  patch did not apply: ${r.apply.outputTail.trim().split("\n")[0]}`);
  }
  for (const c of r.results) {
    lines.push(`  ${c.name}  ${c.command}  ${c.timedOut ? "TIMEOUT" : `exit ${c.exitCode}`}  ` +
      `${c.durationMs}ms`);
    if (c.exitCode !== 0 || c.timedOut) {
      lines.push(c.outputTail.split("\n").map((l) => `    | ${l}`).join("\n"));
    }
  }
  return lines.join("\n");
}

export async function runCli(
  argv: string[], discovery?: Discovery, io?: ApproveIO,
): Promise<string> {
  const cwd = flagValue(argv, "--cwd", process.cwd());
  const disc = discovery ?? new StubDiscovery({ servers: [] });
  if (argv[0] === "doctor") {
    return runDoctor(cwd, disc);
  }
  if (argv[0] === "init") {
    const { code, output } = await runInit(argv.slice(1), {
      io: {
        out: (l) => process.stdout.write(l + "\n"),
        err: (l) => process.stderr.write(l + "\n"),
        ask: (q) => askOnTerminal(q),
        isTty: Boolean(process.stdin.isTTY),
      },
    });
    initExitCode = code;
    return output;
  }
  if (argv[0] === "task" && argv[1] === "new") {
    const h = await createTask(cwd);
    if (await isGitProject(cwd)) await snapshotGit(cwd, h, {});
    else await snapshotManifest(cwd, h);
    return h.taskId;
  }
  if (argv[0] === "task" && argv[1] === "export") {
    const id = argv[2];
    if (!id) throw new Error("usage: tinystrap task export <taskId> [dest]");
    const h = openTask(cwd, id);
    await extractPatch(h);
    const dest = argv[3] ?? join(cwd, `${id}.patch`);
    await exportPatch(h, dest);
    return dest;
  }
  if (argv[0] === "task" && argv[1] === "verify") {
    const id = argv[2];
    if (!id) throw new Error("usage: tinystrap task verify <taskId>");
    const h = openTask(cwd, id);
    const baseline = JSON.parse(readFileSync(h.baselinePath, "utf8")) as Baseline;
    const patch = await extractPatch(h);
    const report = await verifyInFreshWorkspace(h, baseline, patch,
      resolvedVerifyCommands(cwd, await loadConfig({ projectRoot: cwd })));
    const text = formatVerifyReport(report);
    if (!report.passed) {
      throw new Error(`${text}\nThe patch did not pass verification. Fix the task and re-run, `
        + `or export the patch for a human: tinystrap task export ${id}`);
    }
    return text;
  }
  if (argv[0] === "task" && argv[1] === "promote") {
    const id = argv[2];
    if (!id) {
      throw new Error("usage: tinystrap task promote <taskId> [--mode "
        + "apply|export_patch|commit_task_branch|open_pr] [--yes]");
    }
    const h = openTask(cwd, id);
    const baseline = JSON.parse(readFileSync(h.baselinePath, "utf8")) as Baseline;
    const config = await loadConfig({ projectRoot: cwd });
    const configuredMode = String(config["promotion.mode"]?.value ?? "apply");
    const requested = flagValue(argv, "--mode", configuredMode);
    if (!PROMOTION_MODES.includes(requested as PromotionMode)) {
      // Never fall through: an unrecognised mode must not reach promote(),
      // whose final branch is the one mode that talks to a remote.
      throw new Error(`unknown promotion mode "${requested}" `
        + `(expected ${PROMOTION_MODES.join(" | ")})`);
    }
    const mode = requested as PromotionMode;
    // open_pr needs the per-repository opt-in (spec 9.10): the flag alone never
    // turns pushing on, the project's tinystrap.toml has to say so too.
    if (mode === "open_pr" && configuredMode !== "open_pr") {
      throw new Error('open_pr requires the repository opt-in: set promotion.mode = "open_pr" '
        + "in tinystrap.toml");
    }
    const patch = await extractPatch(h);
    const commands = resolvedVerifyCommands(cwd, config);
    const report = await verifyInFreshWorkspace(h, baseline, patch, commands);
    if (!report.passed) {
      throw new Error(`${formatVerifyReport(report)}\n`
        + "Promotion needs a passing verification first.");
    }
    // Built lazily: a run that never asks (--yes, export_patch) never opens a
    // readline interface on a TTY.
    const approve: ApproveIO = io ?? (await import("./prompt.js")).consoleApproveIO();
    const outcome = await promote({
      handle: h, baseline, projectRoot: cwd, patch, report, mode,
      io: approve,
      // --yes may satisfy apply/commit_task_branch, never a push: promote()
      // ignores it for open_pr and always shows the prompt that names the branch.
      assumeYes: argv.includes("--yes"),
      // Spec 9.10 step (4): re-run the same checks inside the protected project
      // after applying, unless [promotion] post_apply_verify = false.
      postApplyCommands: config["promotion.postApplyVerify"]?.value === false ? [] : commands,
    });
    if (outcome.status === "refused") throw new Error(outcome.message);
    if (outcome.status === "applied") {
      const post = outcome.postApplyPassed === null ? "skipped"
        : outcome.postApplyPassed ? "passed" : "failed";
      return `applied: the verified patch is in your project (post-apply checks ${post}). `
        + `Undo it with git checkout, or restore the checkpoint at ${outcome.checkpointDir}`;
    }
    if (outcome.status === "exported") return `exported: ${outcome.destPath}`;
    if (outcome.status === "branch_committed") {
      return `branch_committed: ${outcome.branch} at ${outcome.commit.slice(0, 12)} `
        + "(working tree untouched, nothing pushed)";
    }
    return `pr_opened: ${outcome.branch} ${outcome.prUrl}`;
  }
  if (argv[0] === "task" && argv[1] === "cleanup") {
    const id = argv[2];
    if (!id) throw new Error("usage: tinystrap task cleanup <taskId>");
    await destroyTask(openTask(cwd, id));
    return `cleaned ${id}`;
  }
  throw new Error(`unknown command: ${argv.join(" ")}`);
}

const isEntry = process.argv[1]?.replace(/\\/g, "/").includes("apps/cli/src/main");
if (isEntry) {
  runCli(process.argv.slice(2)).then(
    (out) => {
      console.log(out);
      // `init` is the only command that reports a code of its own; anything else
      // that got here exited 0 as it always has.
      if (initExitCode !== undefined) process.exitCode = initExitCode;
    },
    (err) => { console.error(String(err.message ?? err)); process.exitCode = 1; },
  );
}
