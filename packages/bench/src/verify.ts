// Fresh-copy verification (spec 15): the model's workspace is never the
// verification target. Copy the pristine fixture to a temp dir, apply the
// extracted patch there, copy the hidden verify files in AFTER the patch,
// and run the verify command in the copy.
//
// Deviation from the plan: the plan called for `git init` + `git add -A` +
// `git commit -m baseline` "so git apply works". Verified against git: plain
// `git apply` patches the working tree of a fresh `git init` repo with no
// commit at all, while committing requires a git identity — an environment
// dependency that would make the verifier fail on machines (or CI steps)
// without one. So we init, but do not add/commit.

import { mkdtempSync, rmSync, cpSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type VerifyResult = { passed: boolean; exitCode: number; outputTail: string };

const OUTPUT_TAIL_CHARS = 4000;
const GIT_TIMEOUT_MS = 30_000;
// Commands are "program args..." — anything a shell would interpret is rejected.
const SHELL_METACHARS = /[;&|<>`$(){}\[\]*?~!#\\'"\n]/;

function splitCommand(command: string): string[] {
  if (SHELL_METACHARS.test(command)) {
    throw new Error(`verify command contains forbidden shell metacharacters: ${command}`);
  }
  const parts = command.trim().split(/\s+/).filter((p) => p !== "");
  if (parts.length === 0) throw new Error("verify command is empty");
  return parts;
}

function tail(text: string): string {
  return text.length <= OUTPUT_TAIL_CHARS ? text : text.slice(-OUTPUT_TAIL_CHARS);
}

function spawnCapture(
  cmd: string,
  args: string[],
  cwd: string,
  stdin: string | null,
  timeoutMs: number,
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => { output += d; });
    child.stderr.on("data", (d: Buffer) => { output += d; });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) output += `\nverify command timed out after ${timeoutMs}ms and was killed\n`;
      resolve({ exitCode: code ?? -1, output });
    });
    if (stdin !== null) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

export async function verifyInFreshCopy(
  fixtureDir: string,
  patch: string,
  hiddenDir: string | null,
  command: string,
  timeoutMs = 60_000,
): Promise<VerifyResult> {
  const argv = splitCommand(command); // validated before anything is spawned
  const work = mkdtempSync(join(tmpdir(), "bench-verify-"));
  try {
    const copy = join(work, "copy");
    cpSync(fixtureDir, copy, { recursive: true });
    await spawnCapture("git", ["init", "-q"], copy, null, GIT_TIMEOUT_MS);

    if (patch.trim() !== "") {
      const applied = await spawnCapture(
        "git", ["apply", "--whitespace=nowarn", "-"], copy, patch, GIT_TIMEOUT_MS,
      );
      if (applied.exitCode !== 0) {
        return { passed: false, exitCode: applied.exitCode, outputTail: tail(applied.output) };
      }
    }

    if (hiddenDir) cpSync(hiddenDir, copy, { recursive: true });

    const run = await spawnCapture(argv[0], argv.slice(1), copy, null, timeoutMs);
    return { passed: run.exitCode === 0, exitCode: run.exitCode, outputTail: tail(run.output) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
