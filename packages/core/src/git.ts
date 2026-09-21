import { execFile } from "node:child_process";

export type GitResult = { code: number; stdout: string; stderr: string };

export function runGit(
  cwd: string,
  args: string[],
  opts?: { env?: NodeJS.ProcessEnv },
): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile("git", args,
      { cwd, env: opts?.env ?? process.env, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr });
      });
  });
}
