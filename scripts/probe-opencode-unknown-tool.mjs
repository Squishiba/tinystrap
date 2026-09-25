// OPERATOR-GATED FEASIBILITY PROBE — runs the real opencode binary; never in CI.
// Answers live-check section 5 question 1: what does OpenCode do when the model
// calls a tool the host does not have (the harness_notice interruption channel)?
//
// Usage (after `pnpm typecheck` to build dist/):
//   node --conditions=tinystrap-dist scripts/probe-opencode-unknown-tool.mjs --base-url http://127.0.0.1:8080 --model qwen2.5-coder-7b
// From Git Bash on Windows, prefix with MSYS_NO_PATHCONV=1 if the --model value
// starts with a slash, otherwise Git Bash rewrites it into a Windows path.
//
// Structure follows scripts/live-host-check-opencode.mjs: the host only ever
// talks to the local tinystrap proxy (proxy.url from startProxy, loopback by
// construction — asserted below); --base-url is the operator's own upstream
// model server and is intentionally unrestricted, same as the live-check.
//
// Wall-clock note: the runner's timeoutMs is passed through, but until the F2
// process-tree-kill fix is verified for this flow, if the probe hangs the
// OPERATOR kills the host process tree manually (live-check 5 Q2: a previous
// probe attempt hung at startup).
//
// What it measures, printed at the end:
//   (a) did the host exit cleanly, error, or hang;
//   (b) does request #2 carry a role:"tool" message for the harness_notice
//       call, and what does its content say;
//   (c) the exact exit code.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProxy, HttpProvider, interruptionChunks } from "../packages/proxy/dist/index.js";
import { createTask, destroyTask, snapshotGit } from "../packages/core/dist/index.js";
import { createToolRegistry, evaluate, ScriptLedger, EvasionTracker } from "../packages/policy/dist/index.js";
import { OpenCodeRunner } from "../adapters/opencode/dist/index.js";

const argv = process.argv.slice(2);
const flag = (n) => argv[argv.indexOf(n) + 1];
const baseUrl = flag("--base-url");
const model = flag("--model");
if (!baseUrl || !model) {
  console.error("usage: probe-opencode-unknown-tool.mjs --base-url http://127.0.0.1:<port> --model <id>");
  process.exit(2);
}
try { new URL(baseUrl); } catch {
  console.error(`invalid --base-url: ${baseUrl}`);
  process.exit(2);
}

// Scripted provider: request #1 gets a harness_notice tool call in the exact
// interruptionChunks shape the proxy emits today; every later request gets a
// plain stop-text stream so the run terminates regardless of the host's choice.
class ScriptedProvider {
  seen = [];
  constructor(first, rest) { this.first = first; this.rest = rest; }
  async *stream(req) {
    this.seen.push(req);
    for (const c of this.seen.length === 1 ? this.first : this.rest) yield c;
  }
}

const noticeChunks = interruptionChunks(
  { model: "probe", messages: [] }, "probe: unknown-tool feasibility check");
const noticeCallId = noticeChunks[1].choices[0].delta.tool_calls[0].id;
const textChunks = [
  { choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
];
const provider = new ScriptedProvider(noticeChunks, textChunks);

const projectRoot = mkdtempSync(join(tmpdir(), "probe-unknown-tool-"));
writeFileSync(join(projectRoot, "hello.txt"), "wrld\n");
execFileSync("git", ["init"], { cwd: projectRoot, stdio: "pipe" });
execFileSync("git", ["add", "hello.txt"], { cwd: projectRoot, stdio: "pipe" });
execFileSync("git",
  ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-m", "init"],
  { cwd: projectRoot, stdio: "pipe" });
const handle = await createTask(projectRoot);
await snapshotGit(projectRoot, handle);

const registry = createToolRegistry();
const ledger = new ScriptLedger();
const evasion = new EvasionTracker();
const proxy = await startProxy({
  provider,
  registry,
  preflight: (tool, args) => evaluate(
    { tool, args, cwd: handle.workspaceDir, taskId: handle.taskId, phase: "implementation" },
    { workspaceRoot: handle.workspaceDir, registry, readSet: new Set(),
      exists: () => false, realPaths: new Map(), ledger, evasion },
  ),
  onEvent: (e) => console.log(`[event] ${e.kind} ${e.tool ?? ""}`),
});
// Loopback guard: the host must only ever reach the proxy on loopback.
if (!proxy.url.startsWith("http://127.0.0.1:")) {
  console.error(`proxy bound to a non-loopback address: ${proxy.url}`);
  await proxy.close();
  destroyTask(handle);
  process.exit(2);
}

const result = await new OpenCodeRunner().run({
  taskId: handle.taskId,
  prompt: "Say ok.",
  workspaceDir: handle.workspaceDir, logsDir: handle.logsDir,
  model, proxyBaseUrl: proxy.url, timeoutMs: 120_000,
});
await proxy.close();

// (b) what came back for the harness_notice call on request #2
const second = provider.seen[1];
const toolMsg = second?.messages.find((m) =>
  m.role === "tool" && m.tool_call_id === noticeCallId);
console.log("=== probe result (live-check 5 Q1) ===");
console.log("(a) host outcome:",
  result.timedOut ? "HANG (runner timeout fired; operator: kill the process tree if it lingers)"
    : result.cancelled ? "cancelled"
      : result.exitCode === 0 ? "exited cleanly" : `errored (exit ${result.exitCode})`);
console.log(`(b) request #2 tool message for harness_notice call ${noticeCallId}:`,
  toolMsg ? `PRESENT: ${JSON.stringify(toolMsg.content)}` : "ABSENT");
console.log("(c) exit code:", result.exitCode);
console.log("transcript:", result.transcriptPath);
// Keep the task dir for inspection; print it instead of deleting:
console.log("task dir:", handle.taskDir);
