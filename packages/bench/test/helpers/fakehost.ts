import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HostRunner, HostTask, HostRunResult } from "@tinystrap/core";

// Deterministic stand-in for a real host: applies `fix` to the task workspace
// (simulating a host that edits files), writes an empty transcript, succeeds.
export class FakeHostRunner implements HostRunner {
  constructor(private readonly fix: (workspaceDir: string) => void) {}

  async run(task: HostTask): Promise<HostRunResult> {
    this.fix(task.workspaceDir);
    const transcriptPath = join(task.logsDir, "host-transcript.jsonl");
    writeFileSync(transcriptPath, "");
    return {
      exitCode: 0,
      events: [],
      transcriptPath,
      timedOut: false,
      cancelled: false,
    };
  }
}
