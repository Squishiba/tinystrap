import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runGit } from "./git.js";
import type { TaskHandle } from "./taskstore.js";

export async function extractPatch(handle: TaskHandle): Promise<string> {
  const baseline = JSON.parse(readFileSync(handle.baselinePath, "utf8")) as { revision: string };
  if (!baseline.revision.startsWith("git:")) {
    throw new Error("patch extraction is only supported for git baselines in M1");
  }
  const rev = baseline.revision.replace(/^git:/, "");
  const tmpIndex = join(handle.taskDir, "tmp.index");
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  const add = await runGit(handle.workspaceDir, ["add", "-A"], { env });
  if (add.code !== 0) throw new Error(`patch add failed: ${add.stderr}`);
  const diff = await runGit(handle.workspaceDir, ["diff", "--cached", rev], { env });
  if (diff.code !== 0) throw new Error(`patch diff failed: ${diff.stderr}`);
  writeFileSync(handle.patchPath, diff.stdout);
  return diff.stdout;
}

export async function exportPatch(handle: TaskHandle, destPath: string): Promise<void> {
  copyFileSync(handle.patchPath, destPath);
}
