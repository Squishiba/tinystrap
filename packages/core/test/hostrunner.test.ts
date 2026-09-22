import { describe, expect, it } from "vitest";
import { makeEvent } from "@tinystrap/policy";
import type { HostRunner, HostTask, HostRunResult } from "@tinystrap/core";

class StubRunner implements HostRunner {
  async run(task: HostTask): Promise<HostRunResult> {
    return {
      exitCode: 0,
      events: [makeEvent(task.taskId, "host_event", { hostEventType: "stub" })],
      transcriptPath: `${task.logsDir}/host-transcript.jsonl`,
      timedOut: false,
      cancelled: false,
    };
  }
}

describe("HostRunner contract", () => {
  it("a stub runner satisfies the interface", async () => {
    const r = await new StubRunner().run({
      taskId: "t1", prompt: "p", workspaceDir: "/w", logsDir: "/l",
      model: "m", proxyBaseUrl: "http://127.0.0.1:8787", timeoutMs: 1000,
    });
    expect(r.exitCode).toBe(0);
    expect(r.events[0].kind).toBe("host_event");
    expect(r.transcriptPath).toContain("host-transcript.jsonl");
  });
});