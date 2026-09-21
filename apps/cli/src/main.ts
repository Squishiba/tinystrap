import { join } from "node:path";
import {
  createTask, destroyTask, exportPatch, extractPatch, openTask, runDoctor,
  snapshotGit, isGitProject, snapshotManifest,
} from "@tinystrap/core";
import { Discovery, StubDiscovery } from "@tinystrap/discovery";

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
    (out) => console.log(out),
    (err) => { console.error(String(err.message ?? err)); process.exitCode = 1; },
  );
}
