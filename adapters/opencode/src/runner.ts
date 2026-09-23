import { spawn } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { HostRunner, HostTask, HostRunResult } from "@tinystrap/core";
import { buildOpenCodeConfig } from "./config.js";
import { buildOpenCodeArgs } from "./argv.js";
import { parseOpenCodeJsonl } from "./parse.js";

export type OpenCodeRunnerOptions = {
  bin?: string;
  binPrefixArgs?: string[];
};

export class OpenCodeRunner implements HostRunner {
  constructor(private readonly opts: OpenCodeRunnerOptions = {}) {}

  run(task: HostTask, signal?: AbortSignal): Promise<HostRunResult> {
    const configPath = join(task.workspaceDir, "opencode.json");
    writeFileSync(configPath, JSON.stringify(buildOpenCodeConfig(task.proxyBaseUrl, task.model), null, 2));
    const transcriptPath = join(task.logsDir, "host-transcript.jsonl");

    return new Promise<HostRunResult>((resolve) => {
      const child = spawn(this.opts.bin ?? "opencode",
        [...(this.opts.binPrefixArgs ?? []), ...buildOpenCodeArgs(task)],
        { cwd: task.workspaceDir, stdio: ["ignore", "pipe", "pipe"], shell: false });

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
        try { rmSync(configPath, { force: true }); } catch { /* best effort */ }
        // The host writes each line followed by "\n", so raw.split("\n") ends
        // with a trailing empty string. parseOpenCodeJsonl maps blank lines to
        // a host_event, which would add a phantom event; drop empty lines here
        // while the transcript file itself stays byte-faithful to raw stdout.
        const lines = raw.split("\n").filter((l) => l.length > 0);
        resolve({
          exitCode: code ?? -1,
          events: parseOpenCodeJsonl(task.taskId, lines),
          transcriptPath,
          timedOut,
          cancelled,
        });
      });
    });
  }
}

// Windows note: child.kill("SIGKILL") kills the direct child only. If opencode
// spawns tool subprocesses that survive, a future fix would escalate to
// `taskkill /F /T /PID <pid>` — not built here, just noted.
