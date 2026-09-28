// The injectable process seam for the verifier and the promotion broker.
// Unlike runGit (kept as-is for existing callers): argv-only spawn (shell is
// never involved), optional stdin payload (patches arrive as bytes), and a
// timeout that kills the WHOLE process tree via killProcessTree — a test
// runner that forked workers dies with it (spec 9.8 process-tree cleanup).
import { spawn } from "node:child_process";
import { killProcessTree } from "./killtree.js";

export type RunResult = { code: number; stdout: string; stderr: string; timedOut: boolean };
export type RunOptions = { cwd: string; env?: NodeJS.ProcessEnv; stdin?: string; timeoutMs?: number };
export type CommandRunner =
  (cmd: string, args: string[], opts: RunOptions) => Promise<RunResult>;

export const defaultCommandRunner: CommandRunner = (cmd, args, opts) =>
  new Promise<RunResult>((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      // POSIX: lead our own process group so killProcessTree signals every
      // descendant (same discipline as the host runners).
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d: Buffer) => { stdout += d; });
    child.stderr.on("data", (d: Buffer) => { stderr += d; });
    const timer = opts.timeoutMs
      ? setTimeout(() => { timedOut = true; killProcessTree(child.pid ?? -1); }, opts.timeoutMs)
      : undefined;
    child.on("error", () => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + `\nspawn failed: ${cmd}`, timedOut });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: timedOut || code === null ? -1 : code, stdout, stderr, timedOut });
    });
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
    else child.stdin.end();
  });
