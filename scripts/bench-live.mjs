// Operator-gated: runs the tinystrap bench FOR REAL against the operator's
// own model server through a real OpenCode host (OpenCodeRunner + the proxy
// with createOpenCodeDialect() + HttpProvider, the same recipe as
// scripts/live-host-check-opencode.mjs). Tasks run SEQUENTIALLY — one host
// at a time — so results are not distorted by slot contention on the server.
// Usage (after `pnpm typecheck` to build dist/):
//   node --conditions=tinystrap-dist scripts/bench-live.mjs --base-url http://<host>:<port> --model <id>
//   node --conditions=tinystrap-dist scripts/bench-live.mjs --list   # ids + configs, no network
// Flags: --tasks <comma ids> (default: all coding tasks) --configs <comma
// matrix labels> (default: full) --repeat <n> --timeout-ms <per task> --out
// <dir> (default: a new directory under the OS temp dir) --label <short name>.
// The safety scenarios replay recorded streams (no model needed) and always
// run once, under config "full", in the same report.
// Results are written incrementally: one JSON line per finished run in
// <out>/results.jsonl, flushed as it goes, so a killed run keeps its partial
// data. SIGINT finishes the current run and its write, writes the report, and
// exits. The host tree kill on timeout is owned by OpenCodeRunner.
// Privacy: results.jsonl and report.md never contain the base URL, the model
// id or any local path — the model appears only as the --label short name
// (default "model"). The output directory is printed at the end.
// The relative dist/ imports below are required because scripts/ is not a
// workspace member; --conditions=tinystrap-dist makes each package's internal
// cross-package imports resolve to its built dist/. Never run from CI.
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HttpProvider } from "../packages/proxy/dist/index.js";
import { createOpenCodeDialect } from "../packages/policy/dist/index.js";
import { OpenCodeRunner } from "../adapters/opencode/dist/index.js";
import {
  loadTasks, runSafetyScenario, runLiveTask, renderMarkdown,
  parseBenchLiveArgs, sanitizeRunResult, formatProgressLine,
  BENCH_LIVE_USAGE, TIER1_MATRIX,
} from "../packages/bench/dist/index.js";

let args;
try {
  args = parseBenchLiveArgs(process.argv.slice(2));
} catch (err) {
  console.error(BENCH_LIVE_USAGE);
  console.error(String(err?.message ?? err));
  process.exit(2);
}

const tasksRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "bench", "tasks");
const allTasks = loadTasks(tasksRoot);
const matrixLabels = TIER1_MATRIX.map((c) => c.label);

if (args.list) {
  console.log("tasks:");
  for (const t of allTasks) console.log(`  ${t.id} (${t.kind})`);
  console.log("configs:");
  for (const label of matrixLabels) console.log(`  ${label}`);
  process.exit(0);
}

const codingTasks = allTasks.filter((t) => t.kind === "coding");
const safetyTasks = allTasks.filter((t) => t.kind === "safety");

let selected = codingTasks;
if (args.tasks !== null) {
  const unknown = args.tasks.filter((id) => !codingTasks.some((t) => t.id === id));
  if (unknown.length > 0) {
    console.error(`unknown --tasks id: ${unknown.join(", ")} (see --list)`);
    process.exit(2);
  }
  selected = codingTasks.filter((t) => args.tasks.includes(t.id));
}

let configs = (args.configs ?? ["full"]).map(
  (label) => TIER1_MATRIX.find((c) => c.label === label),
);
if (configs.some((c) => c === undefined)) {
  const wanted = (args.configs ?? ["full"]);
  const unknown = wanted.filter((label) => !matrixLabels.includes(label));
  console.error(`unknown --configs label: ${unknown.join(", ")} (see --list)`);
  process.exit(2);
}

const outDir = args.out ?? mkdtempSync(join(tmpdir(), "bench-live-"));
mkdirSync(outDir, { recursive: true });
const resultsPath = join(outDir, "results.jsonl");

// SIGINT: stop starting new runs; the current run finishes (its own timeout
// still owns the host-tree kill), its line is flushed, then the report is
// written below the loops. A second SIGINT exits immediately — the jsonl is
// append-per-run, so nothing written so far is lost either way.
let stopRequested = false;
process.on("SIGINT", () => {
  if (stopRequested) process.exit(130);
  stopRequested = true;
  console.log("SIGINT received: finishing the current run, then writing the report…");
});

const results = [];
const record = (r) => {
  results.push(r);
  appendFileSync(resultsPath, `${JSON.stringify(sanitizeRunResult(r, args.label))}\n`);
  console.log(formatProgressLine(r, args.label));
};

// Safety scenarios first: recorded-stream replays through the real gate, no
// model and no host involved, so they cost nothing and always appear.
for (const task of safetyTasks) {
  record(await runSafetyScenario(task, { config: "full" }));
  if (stopRequested) break;
}

const host = new OpenCodeRunner();
const provider = new HttpProvider({ baseUrl: args.baseUrl });

outer:
for (const cfg of configs) {
  const features = Object.fromEntries(cfg.disabled.map((name) => [name, false]));
  for (let rep = 0; rep < args.repeat; rep++) {
    for (const task of selected) {
      try {
        record(await runLiveTask(task, {
          host, provider, features,
          dialect: createOpenCodeDialect(),
          model: args.model,
          config: cfg.label,
          timeoutMs: args.timeoutMs,
        }));
      } catch (err) {
        // One crashed run must not lose the others' data; log and continue.
        console.error(`run failed (${task.id} / ${cfg.label}): ${String(err?.message ?? err)}`);
      }
      if (stopRequested) break outer;
    }
  }
}

writeFileSync(join(outDir, "report.md"), renderMarkdown(results));
console.log(`output directory: ${outDir}`);
process.exit(0);
