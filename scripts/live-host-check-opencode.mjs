// Operator-gated: verifies the OpenCode adapter end-to-end against a REAL local
// model server the operator already started. Usage:
//   node scripts/live-host-check-opencode.mjs --base-url http://127.0.0.1:8080 --model qwen2.5-coder-7b
// Refuses non-loopback URLs. Never run from CI.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProxy, HttpProvider } from "@tinystrap/proxy";
import { createTask, extractPatch, destroyTask } from "@tinystrap/core";
import { createToolRegistry, evaluate, ScriptLedger, EvasionTracker } from "@tinystrap/policy";
import { OpenCodeRunner } from "@tinystrap/adapter-opencode";

const argv = process.argv.slice(2);
const flag = (n) => argv[argv.indexOf(n) + 1];
const baseUrl = flag("--base-url");
const model = flag("--model");
if (!baseUrl || !model) {
  console.error("usage: live-host-check-opencode.mjs --base-url http://127.0.0.1:<port> --model <id>");
  process.exit(2);
}
if (!/127\.0\.0\.1|localhost/.test(baseUrl)) {
  console.error("refusing non-loopback base URL");
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
