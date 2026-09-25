// Operator-gated: verifies the OpenCode adapter end-to-end against a REAL local
// model server the operator already started. Runs the proxy with the OpenCode
// host dialect (createOpenCodeDialect), so OpenCode's real argument names
// (filePath/oldString/...) are canonicalized before preflight.
// Usage (after `pnpm typecheck` to build dist/):
//   node --conditions=tinystrap-dist scripts/live-host-check-opencode.mjs --base-url http://127.0.0.1:8080 --model qwen2.5-coder-7b
// From Git Bash on Windows, prefix with MSYS_NO_PATHCONV=1 if the --model value starts with a slash, otherwise Git Bash rewrites it into a Windows path.
// The relative dist/ imports below are required because scripts/ is not a
// workspace member, so bare @tinystrap/* specifiers have no node_modules to
// resolve from here; the --conditions=tinystrap-dist flag is what makes each
// package's own internal cross-package imports resolve to its built dist/
// output instead of raw TS source.
// Never run from CI.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProxy, HttpProvider } from "../packages/proxy/dist/index.js";
import { createTask, extractPatch, destroyTask, snapshotGit } from "../packages/core/dist/index.js";
import { createToolRegistry, evaluate, ScriptLedger, EvasionTracker, createOpenCodeDialect } from "../packages/policy/dist/index.js";
import { OpenCodeRunner } from "../adapters/opencode/dist/index.js";

const argv = process.argv.slice(2);
const flag = (n) => argv[argv.indexOf(n) + 1];
const baseUrl = flag("--base-url");
const model = flag("--model");
if (!baseUrl || !model) {
  console.error("usage: live-host-check-opencode.mjs --base-url http://127.0.0.1:<port> --model <id>");
  process.exit(2);
}
// The host (opencode) only ever talks to the local tinystrap proxy, and that
// connection is always loopback by construction: it uses proxy.url returned by
// startProxy(), which binds locally, never a separately configurable address.
// --base-url is a different thing: it is where the proxy's own upstream request
// goes (the HttpProvider target), i.e. the operator's own real model server,
// which this project has always supported running on a LAN address, not just
// localhost (see scripts/feasibility-mid-stream-close.mjs, which takes an
// arbitrary operator-supplied base URL with no loopback restriction). It is
// therefore intentionally unrestricted.
try { new URL(baseUrl); } catch {
  console.error(`invalid --base-url: ${baseUrl}`);
  process.exit(2);
}

// Render one HarnessEvent (see packages/policy/src/audit.ts) as a single line
// with every field except the timestamp and the kind (the kind is the prefix),
// so the tool name, arguments, decision and reason are all visible. String
// values are truncated recursively so a long command or digest stays on one line.
function formatEventLine(e) {
  const trunc = (v) =>
    typeof v === "string" ? (v.length > 300 ? `${v.slice(0, 300)}…` : v)
    : Array.isArray(v) ? v.map(trunc)
    : v && typeof v === "object"
      ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, trunc(x)]))
      : v;
  const { timestamp, kind, ...rest } = e;
  return `[event] ${kind} ${JSON.stringify(trunc(rest))}`;
}

const eventCounts = new Map();

const projectRoot = mkdtempSync(join(tmpdir(), "live-host-"));
writeFileSync(join(projectRoot, "hello.txt"), "wrld\n");
// createTask() only creates the task directories; the workspace must be
// populated by snapshotting the project, exactly as the supervisor flow does
// (apps/cli/src/main.ts). snapshotGit() requires a real git project, so make
// the temp project one (with inline -c identity args so no global git config
// is touched) before snapshotting.
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
  provider: new HttpProvider({ baseUrl }),
  registry,
  dialect: createOpenCodeDialect(),
  preflight: (tool, args) => evaluate(
    { tool, args, cwd: handle.workspaceDir, taskId: handle.taskId, phase: "implementation" },
    { workspaceRoot: handle.workspaceDir, registry, readSet: new Set(),
      exists: () => false, realPaths: new Map(), ledger, evasion },
  ),
  onEvent: (e) => {
    eventCounts.set(e.kind, (eventCounts.get(e.kind) ?? 0) + 1);
    console.log(formatEventLine(e));
  },
});

const result = await new OpenCodeRunner().run({
  taskId: handle.taskId,
  prompt: "Change hello.txt to contain exactly: hello world",
  workspaceDir: handle.workspaceDir, logsDir: handle.logsDir,
  model, proxyBaseUrl: proxy.url, timeoutMs: 300_000,
});
await proxy.close();

console.log("event summary: " +
  ([...eventCounts].map(([kind, n]) => `${kind}=${n}`).join(" ") || "(none)"));

console.log({ exitCode: result.exitCode, timedOut: result.timedOut,
  cancelled: result.cancelled, transcript: result.transcriptPath });
if (result.timedOut || result.cancelled) {
  console.log("note: host was stopped by the runner's timeout/abort");
}
console.log("patch:\n" + (await extractPatch(handle)).slice(0, 4000));
// Keep the task dir for inspection; print it instead of deleting:
console.log("task dir:", handle.taskDir);
