import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HostRunner, HostTask, HostRunResult } from "@tinystrap/core";
import { parsePiJsonl } from "./parse.js";

export type PiRunnerOptions = {
  bin?: string;
  binPrefixArgs?: string[];
};

export class PiRunner implements HostRunner {
  constructor(private readonly opts: PiRunnerOptions = {}) {}

  run(task: HostTask, signal?: AbortSignal): Promise<HostRunResult> {
    // Unlike OpenCodeRunner, no config file is written into the workspace:
    // pi gets its model endpoint via the environment. UNVERIFIED: whether pi
    // actually reads OPENAI_BASE_URL, a config file, or a CLI flag to select
    // its endpoint — env var is this task's first guess; a later operator-
    // gated live check (Task 9) confirms it against a real pi install.
    const transcriptPath = join(task.logsDir, "host-transcript.jsonl");

    return new Promise<HostRunResult>((resolve) => {
      const child = spawn(this.opts.bin ?? "pi",
        [...(this.opts.binPrefixArgs ?? []), "-p", "--mode", "json", task.prompt],
        {
          cwd: task.workspaceDir,
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
          env: { ...process.env, OPENAI_BASE_URL: `${task.proxyBaseUrl.replace(/\/+$/, "")}/v1` },
        });

      let raw = "";
      child.stdout.on("data", (d: Buffer) => { raw += d.toString(); });

      let timedOut = false;
      let cancelled = false;
      const killer = () => { timedOut = true; child.kill("SIGKILL"); };
      const aborter = () => { cancelled = true; child.kill("SIGKILL"); };
      const timer = setTimeout(killer, task.timeoutMs);
      signal?.addEventListener("abort", aborter, { once: true });

      child.on("error", () => { /* missing bin: resolve below with exitCode -1 */ });
      child.on("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", aborter);
        writeFileSync(transcriptPath, raw);
        // The host writes each line followed by "\n", so raw.split("\n") ends
        // with a trailing empty string. parsePiJsonl maps blank lines to
        // a host_event, which would add a phantom event; drop empty lines here
        // while the transcript file itself stays byte-faithful to raw stdout.
        const lines = raw.split("\n").filter((l) => l.length > 0);
        resolve({
          exitCode: code ?? -1,
          events: parsePiJsonl(task.taskId, lines),
          transcriptPath,
          timedOut,
          cancelled,
        });
      });
    });
  }
}

// Windows note: child.kill("SIGKILL") kills the direct child only. If pi
// spawns tool subprocesses that survive, a future fix would escalate to
// `taskkill /F /T /PID <pid>` — not built here, just noted.
