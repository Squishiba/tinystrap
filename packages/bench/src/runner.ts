// runTask: the composed bench harness (spec 15). Fixture -> temp git project
// -> core task workspace + baseline -> in-process proxy with the real policy
// gate -> HostRunner -> patch extraction -> fresh-copy verification ->
// metrics from proxy audit events. The model's workspace is never the
// verification target; verification happens in verifyInFreshCopy.
//
// Deviations from the plan (reported):
// - RunOptions gained `tasksRoot`: BenchTask carries no on-disk location, so
//   runTask needs the suite root to find fixture/ and verify/. Defaults to
//   this package's tasks/ directory.
// - The initial commit sets identity via GIT_*_IDENT env vars so the harness
//   is hermetic on machines without a configured git identity (CI provides
//   one; the env vars make local runs independent of it).
// - No tree-kill is needed here: runTask spawns no host process itself (the
//   HostRunner owns its process), and verifyInFreshCopy's direct-child kill
//   is unchanged.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTask, destroyTask, extractPatch, snapshotGit } from "@tinystrap/core";
import type { HostRunner, HostRunResult, TaskHandle } from "@tinystrap/core";
import { FakeProvider, startProxy } from "@tinystrap/proxy";
import type { Provider, ProxyFeatures } from "@tinystrap/proxy";
import type { HarnessEvent } from "@tinystrap/policy";
import type { BenchTask } from "./taskfile.js";
import { verifyInFreshCopy } from "./verify.js";
import type { VerifyResult } from "./verify.js";
import { makeBenchRegistry, makePreflight } from "./policywire.js";
import { collectMetrics } from "./metrics.js";
import type { BenchMetrics } from "./metrics.js";

export type RunOptions = {
  host: HostRunner;
  provider?: Provider; // coding: unused by FakeHostRunner, required for real hosts
  features?: Partial<ProxyFeatures>;
  budgetTokens?: number;
  tasksRoot?: string;
};

export type BenchRunResult = {
  taskId: string;
  config: string; // ablation label, default "full"
  resolved: boolean;
  metrics: BenchMetrics;
  verify: VerifyResult | null; // null for safety tasks
  hostResult: HostRunResult | null;
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

// A stream nobody should ever read: FakeHostRunner does not talk to the proxy,
// but ProxyDeps requires a provider for real hosts (the caller supplies it).
function unusedProvider(): Provider {
  return new FakeProvider([{
    server: "bench", attempt: "unused", status: 200,
    chunks: [{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }], summary: {},
  }]);
}

export async function runTask(
  task: BenchTask,
  opts: RunOptions & { config?: string },
): Promise<BenchRunResult> {
  const config = opts.config ?? "full";
  const t0 = Date.now();
  const events: HarnessEvent[] = [];
  const projectDir = mkdtempSync(join(tmpdir(), "bench-run-"));
  let proxy: { url: string; close(): Promise<void> } | null = null;
  let handle: TaskHandle | null = null;
  try {
    // ① fixture -> temp project dir with an initial commit (what snapshotGit expects)
    cpSync(join(opts.tasksRoot ?? DEFAULT_TASKS_ROOT, task.id, "fixture"), projectDir,
      { recursive: true });
    git(projectDir, ["init", "-q"]);
    git(projectDir, ["add", "-A"]);
    git(projectDir, ["commit", "-q", "-m", "bench baseline"]);

    // ② core task workspace + git baseline
    handle = await createTask(projectDir);
    await snapshotGit(projectDir, handle);

    // ③ in-process proxy with the real policy gate over the task workspace
    const registry = makeBenchRegistry();
    proxy = await startProxy({
      provider: opts.provider ?? unusedProvider(),
      registry,
      preflight: makePreflight({
        workspaceRoot: handle.workspaceDir,
        registry,
        taskId: task.id,
        phase: "implementation",
        exists: (p) => existsSync(p),
      }),
      onEvent: (e) => events.push(e),
      features: opts.features,
      budgetTokens: opts.budgetTokens,
      taskId: task.id,
    }, 0);

    // ④ host run against the proxied model endpoint
    const hostResult = await opts.host.run({
      taskId: handle.taskId,
      prompt: task.prompt,
      workspaceDir: handle.workspaceDir,
      logsDir: handle.logsDir,
      model: "bench",
      proxyBaseUrl: proxy.url,
      timeoutMs: task.timeoutMs,
    });

    // ⑤ extract the patch the host's edits produced
    const patch = await extractPatch(handle);

    // ⑥ fresh-copy verification: pristine fixture + patch + hidden verify files
    if (!task.verify) throw new Error(`task ${task.id}: coding task has no verify command`);
    const taskDir = join(opts.tasksRoot ?? DEFAULT_TASKS_ROOT, task.id);
    const hiddenDir = join(taskDir, "verify");
    const verify = await verifyInFreshCopy(
      join(taskDir, "fixture"), patch, existsSync(hiddenDir) ? hiddenDir : null, task.verify,
    );

    // ⑦ metrics from proxy audit events, not host output
    const metrics = collectMetrics(events, Date.now() - t0);

    return {
      taskId: task.id,
      config,
      resolved: verify.passed === (task.expected === "resolved"),
      metrics,
      verify,
      hostResult,
    };
  } finally {
    // ⑧ teardown: proxy, core task, temp project dir
    if (proxy) await proxy.close().catch(() => {});
    if (handle) await destroyTask(handle).catch(() => {});
    rmSync(projectDir, { recursive: true, force: true });
  }
}
