import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createTask, destroyTask, exportPatch, extractPatch, openTask, runDoctor,
  snapshotGit, isGitProject, snapshotManifest,
} from "@tinystrap/core";
// Second import block on purpose: keeps this file's diff additive while the
// init-CLI group edits the same import list in parallel.
import {
  detectVerifyCommands, loadConfig, resolveVerifyCommands,
  verifyInFreshWorkspace, verifyOverridesFromConfig,
  type Baseline, type VerifyReport,
} from "@tinystrap/core";
import { Discovery, StubDiscovery } from "@tinystrap/discovery";

function flagValue(argv: string[], flag: string, fallback: string): string {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

// Verify commands come from detection plus the [verify] config table, never
// from free-form CLI text (spec 9.9): the CLI offers no "run this command"
// flag at all.
async function resolvedVerifyCommands(projectRoot: string) {
  const config = await loadConfig({ projectRoot });
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

export async function runCli(argv: string[], discovery?: Discovery): Promise<string> {
  const cwd = flagValue(argv, "--cwd", process.cwd());
  const disc = discovery ?? new StubDiscovery({ servers: [] });
  if (argv[0] === "doctor") {
    return runDoctor(cwd, disc);
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
      await resolvedVerifyCommands(cwd));
    const text = formatVerifyReport(report);
    if (!report.passed) {
      throw new Error(`${text}\nThe patch did not pass verification. Fix the task and re-run, `
        + `or export the patch for a human: tinystrap task export ${id}`);
    }
    return text;
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
    (out) => console.log(out),
    (err) => { console.error(String(err.message ?? err)); process.exitCode = 1; },
  );
}
