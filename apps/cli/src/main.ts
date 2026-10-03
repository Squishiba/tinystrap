import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  createTask, destroyTask, exportPatch, extractPatch, openTask, runDoctor,
  snapshotGit, isGitProject, snapshotManifest,
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

function flagValue(argv: string[], flag: string, fallback: string): string {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

export async function runCli(argv: string[], discovery?: Discovery): Promise<string> {
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
