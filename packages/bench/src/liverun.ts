// Live-run support for scripts/bench-live.mjs (operator-gated bench against a
// real model server). Why this exists instead of plain runTask/runAblation:
// - runTask hard-codes model "bench" in HostTask and never passes `dialect`
//   to startProxy, so a real OpenCode host would reach preflight with raw
//   filePath/oldString argument names (un-canonicalized path checks) and the
//   wrong model id.
// - runAblation does not thread a `provider` through to runTask, so a real
//   HttpProvider cannot be injected through it at all.
// runLiveTask composes the SAME pipeline as runner.ts (fixture -> temp git
// project -> core task -> gated in-process proxy -> host -> fresh-copy
// verification -> metrics from proxy audit events) with three additions:
// `provider`, `dialect` and `model` are caller-supplied, and `timeoutMs`
// overrides the task's own timeout. Keep it in sync with runner.ts.
//
// The argument parser, sanitizer and progress formatter are here (not in the
// script) so they are unit-testable offline: the live path itself is only
// ever exercised by an operator against their own server, never by CI.

import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTask, destroyTask, extractPatch, snapshotGit } from "@tinystrap/core";
import type { HostRunner, TaskHandle } from "@tinystrap/core";
import { createToolRegistry } from "@tinystrap/policy";
import type { HostDialect } from "@tinystrap/policy";
import type { HarnessEvent } from "@tinystrap/policy";
import { startProxy } from "@tinystrap/proxy";
import type { Provider, ProxyFeatures } from "@tinystrap/proxy";
import type { BenchTask } from "./taskfile.js";
import type { BenchRunResult } from "./runner.js";
import type { VerifyResult } from "./verify.js";
import { verifyInFreshCopy } from "./verify.js";
import { makePreflight } from "./policywire.js";
import { collectMetrics } from "./metrics.js";
import type { BenchMetrics } from "./metrics.js";

export type LiveRunOptions = {
  host: HostRunner;
  provider: Provider;
  dialect?: HostDialect;
  features?: Partial<ProxyFeatures>;
  model: string;
  config?: string;
  tasksRoot?: string;
  timeoutMs?: number; // overrides task.timeoutMs (the --timeout-ms flag)
  // Operator-local debug artifacts: when set, every run writes raw
  // diagnostics into <debugDir>/<task>-<config>/ (host transcript and stderr,
  // proxy audit events, verify output tail, extracted patch, workspace
  // listing). These contain machine-local paths and raw model output and
  // must NEVER be committed. Default undefined keeps results sanitized.
  debugDir?: string;
};

const DEFAULT_TASKS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "tasks");

const GIT_IDENT_STAMP = "1700000000 +0000";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_IDENT: `tinystrap-bench <bench@invalid> ${GIT_IDENT_STAMP}`,
      GIT_COMMITTER_IDENT: `tinystrap-bench <bench@invalid> ${GIT_IDENT_STAMP}`,
    },
  });
}

export async function runLiveTask(
  task: BenchTask,
  opts: LiveRunOptions,
): Promise<BenchRunResult> {
  const config = opts.config ?? "full";
  const t0 = Date.now();
  const events: HarnessEvent[] = [];
  const projectDir = mkdtempSync(join(tmpdir(), "bench-live-run-"));
  let proxy: { url: string; close(): Promise<void> } | null = null;
  let handle: TaskHandle | null = null;
  try {
    cpSync(join(opts.tasksRoot ?? DEFAULT_TASKS_ROOT, task.id, "fixture"), projectDir,
      { recursive: true });
    git(projectDir, ["init", "-q"]);
    git(projectDir, ["add", "-A"]);
    git(projectDir, ["commit", "-q", "-m", "bench baseline"]);

    handle = await createTask(projectDir);
    await snapshotGit(projectDir, handle);

    // The registry starts EMPTY on purpose for live runs: the proxy seeds it
    // per request from the host's own `tools` array (seedRegistry), which is
    // ground truth for what the host can execute. makeBenchRegistry's extra
    // canonical tools (python, run, delete, apply_patch) would be forwarded
    // to the model as tools a real host like OpenCode does not implement — a
    // model call to one of those phantoms reaches the host as an unrunnable
    // tool call (prime suspect for the live host exitCode 1 failures).
    // Safety scenarios keep makeBenchRegistry: their recorded streams must
    // reach the engine's real checks for the canonical vocabulary.
    const registry = createToolRegistry();
    proxy = await startProxy({
      provider: opts.provider,
      registry,
      dialect: opts.dialect,
      preflight: makePreflight({
        workspaceRoot: handle.workspaceDir,
        registry,
        taskId: task.id,
        phase: "implementation",
        exists: (p) => existsSync(p),
      }),
      onEvent: (e) => events.push(e),
      features: opts.features,
      taskId: task.id,
    }, 0);

    const hostResult = await opts.host.run({
      taskId: handle.taskId,
      prompt: task.prompt,
      workspaceDir: handle.workspaceDir,
      logsDir: handle.logsDir,
      model: opts.model,
      proxyBaseUrl: proxy.url,
      timeoutMs: opts.timeoutMs ?? task.timeoutMs,
    });

    const patch = await extractPatch(handle);

    if (!task.verify) throw new Error(`task ${task.id}: coding task has no verify command`);
    const taskDir = join(opts.tasksRoot ?? DEFAULT_TASKS_ROOT, task.id);
    const hiddenDir = join(taskDir, "verify");
    const verify = await verifyInFreshCopy(
      join(taskDir, "fixture"), patch, existsSync(hiddenDir) ? hiddenDir : null, task.verify,
    );

    const metrics = collectMetrics(events, Date.now() - t0);

    if (opts.debugDir) {
      try {
        writeLiveDebugArtifacts(opts.debugDir, task, config, {
          logsDir: handle.logsDir,
          workspaceDir: handle.workspaceDir,
          events, patch, verify,
        });
      } catch (err) {
        // Debug artifacts must never sink the run itself.
        console.error(`debug artifacts failed (${task.id}/${config}): ${String(err)}`);
      }
    }

    return {
      taskId: task.id,
      config,
      resolved: verify.passed === (task.expected === "resolved"),
      metrics,
      verify,
      hostResult,
    };
  } finally {
    if (proxy) await proxy.close().catch(() => {});
    if (handle) await destroyTask(handle).catch(() => {});
    rmSync(projectDir, { recursive: true, force: true });
  }
}

// ── raw per-run debug artifacts (operator-local, never committed) ───────────

function listTree(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(`${rel}/`);
      out.push(...listTree(join(dir, entry.name), rel));
    } else out.push(rel);
  }
  return out;
}

// Raw, unsanitized per-run diagnostics for the operator's machine only.
// Everything here can contain local paths and raw model output; it is the
// counterpart to sanitizeRunResult, never a replacement for it.
export function writeLiveDebugArtifacts(
  debugDir: string,
  task: BenchTask,
  config: string,
  data: {
    logsDir: string;
    workspaceDir: string;
    events: HarnessEvent[];
    patch: string;
    verify: VerifyResult | null;
  },
): string {
  const dir = join(debugDir, `${task.id}-${config}`);
  mkdirSync(dir, { recursive: true });
  // host-transcript.jsonl and (runner-provided) host-stderr.log live in the
  // task logs dir; copy every file there so a killed run's partial output survives.
  if (existsSync(data.logsDir)) {
    for (const f of readdirSync(data.logsDir)) {
      const src = join(data.logsDir, f);
      if (statSync(src).isFile()) copyFileSync(src, join(dir, f));
    }
  }
  writeFileSync(join(dir, "proxy-events.jsonl"),
    data.events.map((e) => JSON.stringify(e)).join("\n") +
    (data.events.length > 0 ? "\n" : ""));
  writeFileSync(join(dir, "patch.diff"), data.patch);
  writeFileSync(join(dir, "verify-output.txt"), data.verify?.outputTail ?? "");
  writeFileSync(join(dir, "workspace-listing.txt"),
    listTree(data.workspaceDir).join("\n") + "\n");
  return dir;
}

// ── argument parsing (pure, offline-testable) ────────────────────────────────

export const BENCH_LIVE_USAGE =
  "usage: bench-live.mjs --base-url <url> --model <id> [--tasks a,b] [--configs full] " +
  "[--repeat n] [--timeout-ms n] [--out dir] [--debug-dir dir] [--label name] [--list]\n" +
  "--debug-dir: write raw per-run artifacts (host transcript + stderr, proxy audit " +
  "events, verify output tail, extracted patch, workspace listing) into " +
  "<dir>/<task>-<config>/ for local diagnosis. Operator-local ONLY: these files " +
  "contain machine-local paths and raw model output and must never be committed.";

// Git Bash on Windows rewrites absolute POSIX-looking args, and Node on win32
// resolves "/c/dir" against the CURRENT drive, creating C:\c\dir. Reject the
// MSYS shape with a clear message instead of silently writing to the wrong
// place; everything else is anchored to the cwd with path.resolve.
const MSYS_STYLE_PATH = /^\/[a-z](\/|$)/i;

export function resolveOperatorPath(
  raw: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32" && MSYS_STYLE_PATH.test(raw)) {
    throw new Error(
      `MSYS-style path "${raw}" is not usable on Windows (it would resolve to the ` +
      "current drive plus a literal /c/... tree). Pass a Windows-style path such as " +
      "D:\\bench-out or a path relative to the current directory.",
    );
  }
  return resolve(raw);
}

export const BENCH_LIVE_DEFAULTS = { repeat: 1, timeoutMs: 600_000, label: "model" };

export type BenchLiveArgs = {
  baseUrl: string;
  model: string;
  tasks: string[] | null;   // null = all coding tasks
  configs: string[] | null; // null = full config only
  repeat: number;
  timeoutMs: number;
  out: string | null;       // null = caller makes a temp dir; else absolute, resolved
  debugDir: string | null;  // null = no raw artifacts; else absolute, resolved
  label: string;
  list: boolean;
};

function parseCommaList(raw: string): string[] {
  return raw.split(",").map((s) => s.trim()).filter((s) => s !== "");
}

export function parseBenchLiveArgs(argv: readonly string[]): BenchLiveArgs {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const list = argv.includes("--list");
  const baseUrl = get("--base-url");
  const model = get("--model");
  if (!list) {
    if (!baseUrl) throw new Error(`missing --base-url\n${BENCH_LIVE_USAGE}`);
    if (!model) throw new Error(`missing --model\n${BENCH_LIVE_USAGE}`);
  }
  // Intentionally NOT restricted to loopback: operators run a LAN model server.
  if (baseUrl !== undefined) {
    try { new URL(baseUrl); } catch { throw new Error(`invalid --base-url: ${baseUrl}`); }
  }
  const intFlag = (name: string, dflt: number): number => {
    const raw = get(name);
    if (raw === undefined) return dflt;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`invalid --${name.slice(2)}: ${raw}`);
    return n;
  };
  const tasks = get("--tasks");
  const configs = get("--configs");
  const dirFlag = (name: string, raw: string | undefined): string | null => {
    if (raw === undefined) return null;
    if (raw === "") throw new Error(`invalid --${name}: empty`);
    try {
      return resolveOperatorPath(raw);
    } catch (err) {
      throw new Error(`--${name}: ${String((err as Error).message ?? err)}`);
    }
  };
  return {
    baseUrl: baseUrl ?? "",
    model: model ?? "",
    tasks: tasks === undefined ? null : parseCommaList(tasks),
    configs: configs === undefined ? null : parseCommaList(configs),
    repeat: intFlag("--repeat", BENCH_LIVE_DEFAULTS.repeat),
    timeoutMs: intFlag("--timeout-ms", BENCH_LIVE_DEFAULTS.timeoutMs),
    out: dirFlag("out", get("--out")),
    debugDir: dirFlag("debug-dir", get("--debug-dir")),
    label: get("--label") ?? BENCH_LIVE_DEFAULTS.label,
    list,
  };
}

// ── on-disk records (never contain base URL, model id, or local paths) ──────

export type SanitizedRunRecord = {
  label: string; // operator-supplied short name for the model (default "model")
  taskId: string;
  config: string;
  resolved: boolean;
  metrics: BenchMetrics;
  verify: { passed: boolean; exitCode: number } | null;
  host: { exitCode: number; timedOut: boolean; cancelled: boolean } | null;
};

// verify.outputTail and hostResult.transcriptPath carry machine-local paths
// (temp dirs, test runner output) and are therefore dropped entirely.
export function sanitizeRunResult(r: BenchRunResult, label: string): SanitizedRunRecord {
  return {
    label,
    taskId: r.taskId,
    config: r.config,
    resolved: r.resolved,
    metrics: r.metrics,
    verify: r.verify ? { passed: r.verify.passed, exitCode: r.verify.exitCode } : null,
    host: r.hostResult
      ? {
          exitCode: r.hostResult.exitCode,
          timedOut: r.hostResult.timedOut,
          cancelled: r.hostResult.cancelled,
        }
      : null,
  };
}

export function formatProgressLine(r: BenchRunResult, label: string): string {
  const m = r.metrics;
  return `${r.taskId} [${r.config}] ${r.resolved ? "PASS" : "FAIL"} ` +
    `wall=${m.wallMs}ms turns=${m.turns} tokens=${m.tokensPrompt}/${m.tokensCompletion} ` +
    `label=${label}`;
}
