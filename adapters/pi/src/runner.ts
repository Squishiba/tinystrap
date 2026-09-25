import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HostRunner, HostTask, HostRunResult } from "@tinystrap/core";
import { killProcessTree } from "@tinystrap/core";
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
    // Truncate up front, then append each stdout chunk as it arrives: a run
    // killed mid-flight still leaves its partial transcript on disk.
    writeFileSync(transcriptPath, "");

    return new Promise<HostRunResult>((resolve) => {
      const child = spawn(this.opts.bin ?? "pi",
        [...(this.opts.binPrefixArgs ?? []), "-p", "--mode", "json", task.prompt],
        {
          cwd: task.workspaceDir,
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
          // POSIX: the child leads its own process group so killProcessTree
          // can signal every process it spawned, not just the direct child.
          detached: process.platform !== "win32",
          env: { ...process.env, OPENAI_BASE_URL: `${task.proxyBaseUrl.replace(/\/+$/, "")}/v1` },
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
        // The host writes each line followed by "\n", so raw.split("\n") ends
        // with a trailing empty string. parsePiJsonl maps blank lines to
        // a host_event, which would add a phantom event; drop empty lines here
        // while the transcript file itself stays byte-faithful to raw stdout.
        const lines = raw.split("\n").filter((l) => l.length > 0);
        resolve({
          exitCode: timedOut || cancelled || code === null ? -1 : code,
          events: parsePiJsonl(task.taskId, lines),
          transcriptPath,
          timedOut,
          cancelled,
        });
      };

      // Kill the whole tree, then let `close` arrive naturally: once every
      // process in the tree is dead its stdout pipe write handles close, the
      // stream delivers any bytes the host already wrote and ends, and
      // `close` settles with the full partial transcript. Destroying the
      // streams *at kill time* would discard bytes still sitting unread in
      // the OS pipe, silently losing transcript data the host wrote before
      // the kill. Destroy only in the fallback, for the case where a
      // descendant escaped the kill and would keep `close` from ever firing.
      const killAndArmFallback = () => {
        killProcessTree(child.pid ?? -1); // -1 (no pid) is a safe no-op
        fallback = setTimeout(() => {
          try { child.stdout?.destroy(); child.stderr?.destroy(); } catch { /* already closed */ }
          settle(-1);
        }, 1_500);
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
