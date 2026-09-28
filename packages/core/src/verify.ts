// Fresh-copy verification (spec 9.9). The model's workspace is never the
// verification target: the patch is applied to a fresh checkout of the
// baseline in a harness-owned directory and the commands run there.
// Ideas ported from packages/bench/src/verify.ts (which core must not import
// — bench depends on core) with one fix: timeouts kill the whole process
// tree (killProcessTree), not just the direct child.
import { analyzeShell } from "@tinystrap/policy";
import { defaultCommandRunner, type CommandRunner } from "./run.js";
import type { VerifyCommand } from "./verify-commands.js";

export const DEFAULT_VERIFY_TIMEOUT_MS = 120_000;
export const DEFAULT_OUTPUT_TAIL_CHARS = 4000;

// Same fail-closed philosophy as the policy shell analyzer: a verify command
// is a single plain program invocation or it is not run at all. Metacharacters
// are rejected outright (bench parity) AND the command must classify through
// analyzeShell as exactly one redirect-free statement — one vocabulary for
// "what is a safe command" across gate and verifier.
const SHELL_METACHARS = /[;&|<>`$(){}\[\]*?~!#\\'"\n]/;

// Two classes parse cleanly through analyzeShell yet are still not plain
// program invocations, so they are refused by name: package runners that
// resolve and download arbitrary code at run time (the harness is offline in
// automation and the repo's own shell whitelist excludes npx), and shell
// interpreters / privilege wrappers, which would hand a command string to a
// parser neither this check nor the policy gate ever sees.
const FORBIDDEN_PROGRAMS = new Set([
  "npx", "sh", "bash", "zsh", "dash", "ksh", "fish", "cmd", "powershell", "pwsh", "sudo",
]);
const PACKAGE_RUNNERS = new Set(["pnpm", "yarn", "npm"]);
const FETCH_SUBCOMMANDS = new Set(["dlx", "exec"]);

export function splitVerifyCommand(command: string): string[] {
  if (SHELL_METACHARS.test(command)) {
    throw new Error(`verify command contains forbidden shell metacharacters: ${command}`);
  }
  const parts = command.trim().split(/\s+/).filter((p) => p !== "");
  if (parts.length === 0) throw new Error("verify command is empty");
  const analysis = analyzeShell(command);
  if (!analysis.ok) {
    throw new Error(`verify command is not a plain program invocation: ${command}`);
  }
  if (analysis.statements.length !== 1 || analysis.statements[0].redirects.length > 0) {
    throw new Error(`verify command must be a single plain command: ${command}`);
  }
  const { program, args } = analysis.statements[0];
  if (FORBIDDEN_PROGRAMS.has(program)
    || (PACKAGE_RUNNERS.has(program) && FETCH_SUBCOMMANDS.has(args[0] ?? ""))) {
    throw new Error(`verify command is not a plain program invocation: ${command}`);
  }
  return parts;
}

export type VerifyCommandResult = {
  name: string; command: string; exitCode: number;
  timedOut: boolean; outputTail: string; durationMs: number;
};

function tail(text: string, cap: number): string {
  return text.length <= cap ? text : text.slice(-cap);
}

export async function runVerifyCommand(
  cmd: VerifyCommand,
  cwd: string,
  opts: { timeoutMs?: number; outputTailChars?: number; runner?: CommandRunner } = {},
): Promise<VerifyCommandResult> {
  const argv = splitVerifyCommand(cmd.command); // validated before anything spawns
  const timeoutMs = opts.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
  const cap = opts.outputTailChars ?? DEFAULT_OUTPUT_TAIL_CHARS;
  const runner = opts.runner ?? defaultCommandRunner;
  const started = Date.now();
  const r = await runner(argv[0], argv.slice(1), { cwd, timeoutMs });
  const combined = r.stdout + (r.stderr ? `\n${r.stderr}` : "");
  const note = r.timedOut
    ? `\nverify command timed out after ${timeoutMs}ms and its process tree was killed\n`
    : "";
  return {
    name: cmd.name, command: cmd.command,
    exitCode: r.code, timedOut: r.timedOut,
    outputTail: tail(combined + note, cap),
    durationMs: Date.now() - started,
  };
}
