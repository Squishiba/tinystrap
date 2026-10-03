// Operator-gated: runs the init smoke path against a REAL local model server the
// operator already started. This is the only code in the plan that talks to a real
// server; `pnpm test` must never run it, and no CI job may execute it — the guard
// below is the only invocation that is safe anywhere, because it returns before
// opening a socket.
//
// Usage (after `pnpm typecheck` to build dist/):
//   node --conditions=tinystrap-dist scripts/live-init-smoke.mjs --url http://127.0.0.1:8080 --model <id>
//
// scripts/ is not a workspace member, so bare @tinystrap/* specifiers have no
// node_modules to resolve from here; the relative dist/ imports below are required
// for the same reason as in live-host-check-opencode.mjs. The --url is the
// operator's own server: this script never probes anything the operator did not
// name, and the default sweep (no --url) is refused here exactly as `init` requires
// it to be loopback-only.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProxy, HttpProvider } from "../packages/proxy/dist/index.js";
import { createToolRegistry } from "../packages/policy/dist/index.js";
import { runSmokeTest, writeInitConfig, runDoctor } from "../packages/core/dist/index.js";
import { LocalDiscovery, describeAttempts } from "../packages/discovery/dist/index.js";

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const url = flag("--url");
const model = flag("--model");
if (!url || !model) {
  console.error("usage: live-init-smoke.mjs --url <server-url> --model <id>");
  process.exit(2);
}
try { new URL(url); } catch {
  console.error(`invalid --url: ${url}`);
  process.exit(2);
}

// 1. Discovery, exactly as init would run it — against the one target named above.
const discovered = await new LocalDiscovery({ targets: [url] }).probe();
if (discovered.servers.length === 0) {
  console.error("discovery found nothing. " + describeAttempts(discovered.attempts ?? []));
  process.exit(3);
}
console.log("discovered:", JSON.stringify(discovered.servers, null, 2));
if (!discovered.servers[0].models.some((m) => m.id === model)) {
  console.error(`the server does not serve ${model}; it serves `
    + discovered.servers[0].models.map((m) => m.id).join(", "));
  process.exit(2);
}

// 2. The config write, into a scratch directory - never into the operator's project.
const projectRoot = mkdtempSync(join(tmpdir(), "live-init-"));
const { path } = writeInitConfig({
  projectRoot,
  values: { baseUrl: url, model, kind: discovered.servers[0].kind,
    contextLength: discovered.contextLength },
});
console.log("wrote " + path);
console.log(await runDoctor(projectRoot, new LocalDiscovery({ targets: [url] })));

// 3. The smoke test, through a real proxy in front of the real server. The proxy
// binds loopback and is closed below; the only non-loopback hop is the operator's
// own --url, which is the whole point of a live check.
const proxy = await startProxy({
  provider: new HttpProvider({ baseUrl: url }),
  registry: createToolRegistry(),
  preflight: () => ({ effect: "allow" }),
  features: { guidance: false },
  taskId: "live-init-smoke",
});
let result;
try { result = await runSmokeTest({ proxyBaseUrl: proxy.url, model }); }
finally { await proxy.close(); }
console.log("config:"); console.log(readFileSync(path, "utf8"));
console.log("smoke:", result);
process.exit(result.ok ? 0 : 5);
