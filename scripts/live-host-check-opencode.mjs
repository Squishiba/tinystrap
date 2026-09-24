// Operator-gated: verifies the OpenCode adapter end-to-end against a REAL local
// model server the operator already started.
// Usage (after `pnpm typecheck` to build dist/):
//   node --conditions=tinystrap-dist scripts/live-host-check-opencode.mjs --base-url http://127.0.0.1:8080 --model qwen2.5-coder-7b
// The relative dist/ imports below are required because scripts/ is not a
// workspace member, so bare @tinystrap/* specifiers have no node_modules to
// resolve from here; the --conditions=tinystrap-dist flag is what makes each
// package's own internal cross-package imports resolve to its built dist/
// output instead of raw TS source.
// Never run from CI.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProxy, HttpProvider } from "../packages/proxy/dist/index.js";
import { createTask, extractPatch, destroyTask } from "../packages/core/dist/index.js";
import { createToolRegistry, evaluate, ScriptLedger, EvasionTracker } from "../packages/policy/dist/index.js";
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

const projectRoot = mkdtempSync(join(tmpdir(), "live-host-"));
writeFileSync(join(projectRoot, "hello.txt"), "wrld\n");
const handle = await createTask(projectRoot);
const registry = createToolRegistry();
const ledger = new ScriptLedger();
const evasion = new EvasionTracker();
const proxy = await startProxy({
  provider: new HttpProvider({ baseUrl }),
  registry,
  preflight: (tool, args) => evaluate(
    { tool, args, cwd: handle.workspaceDir, taskId: handle.taskId, phase: "implementation" },
    { workspaceRoot: handle.workspaceDir, registry, readSet: new Set(),
      exists: () => false, realPaths: new Map(), ledger, evasion },
  ),
  onEvent: (e) => console.log(`[event] ${e.kind} ${e.tool ?? ""}`),
});

const result = await new OpenCodeRunner().run({
  taskId: handle.taskId,
  prompt: "Change hello.txt to contain exactly: hello world",
  workspaceDir: handle.workspaceDir, logsDir: handle.logsDir,
  model, proxyBaseUrl: proxy.url, timeoutMs: 300_000,
});
await proxy.close();

console.log({ exitCode: result.exitCode, timedOut: result.timedOut,
  cancelled: result.cancelled, transcript: result.transcriptPath });
console.log("patch:\n" + (await extractPatch(handle)).slice(0, 2000));
// Keep the task dir for inspection; print it instead of deleting:
console.log("task dir:", handle.taskDir);
