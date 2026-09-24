import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { HostRunner, HostTask, HostRunResult } from "@tinystrap/core";
import { killProcessTree } from "@tinystrap/core";
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
    // Truncate up front, then append each stdout chunk as it arrives: a run
    // killed mid-flight still leaves its partial transcript on disk.
    writeFileSync(transcriptPath, "");

    return new Promise<HostRunResult>((resolve) => {
      const child = spawn(this.opts.bin ?? "opencode",
        [...(this.opts.binPrefixArgs ?? []), ...buildOpenCodeArgs(task)],
        {
          cwd: task.workspaceDir,
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
          // POSIX: the child leads its own process group so killProcessTree
          // can signal every process it spawned, not just the direct child.
          detached: process.platform !== "win32",
        });

      let raw = "";
      child.stdout.on("data", (d: Buffer) => {
        raw += d.toString();
        appendFileSync(transcriptPath, d);
      });

      let timedOut = false;
      let cancelled = false;
      let settled = false;
      let fallback: NodeJS.Timeout | undefined;
      const settle = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (fallback) clearTimeout(fallback);
        signal?.removeEventListener("abort", aborter);
        try { rmSync(configPath, { force: true }); } catch { /* best effort */ }
        // The host writes each line followed by "\n", so raw.split("\n") ends
        // with a trailing empty string. parseOpenCodeJsonl maps blank lines to
        // a host_event, which would add a phantom event; drop empty lines here
        // while the transcript file itself stays byte-faithful to raw stdout.
        const lines = raw.split("\n").filter((l) => l.length > 0);
        resolve({
          exitCode: timedOut || cancelled || code === null ? -1 : code,
          events: parseOpenCodeJsonl(task.taskId, lines),
          transcriptPath,
          timedOut,
          cancelled,
        });
      };

      // Kill the whole tree, then stop waiting on `close`: an orphaned
      // descendant holding the inherited stdout pipe would keep `close`
      // from ever firing. Destroying the streams plus a short fallback
      // timer bounds the settle even if the OS never closes the pipe.
      const killAndArmFallback = () => {
        killProcessTree(child.pid ?? -1); // -1 (no pid) is a safe no-op
        try { child.stdout?.destroy(); child.stderr?.destroy(); } catch { /* already closed */ }
        fallback = setTimeout(() => settle(-1), 1_500);
        fallback.unref?.();
      };
      const killer = () => { timedOut = true; killAndArmFallback(); };
      const aborter = () => { cancelled = true; killAndArmFallback(); };
      const timer = setTimeout(killer, task.timeoutMs);
      signal?.addEventListener("abort", aborter, { once: true });

      child.on("error", () => { /* missing bin: resolve below with exitCode -1 */ });
      child.on("close", (code) => settle(code));
    });
  }
}
