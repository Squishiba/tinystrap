import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { HostTask } from "@tinystrap/core";
import { PiRunner } from "@tinystrap/adapter-pi";

// Resolved relative to this file: ../fixtures lands in test/fixtures/.
const FAKE = join(fileURLToPath(import.meta.url), "../fixtures/fake-host.mjs");
const dirs: string[] = [];
const mkTask = (over: Partial<HostTask> = {}): HostTask => {
  const dir = mkdtempSync(join(tmpdir(), "pi-run-"));
  dirs.push(dir);
  return {
    taskId: "t1", prompt: "p", workspaceDir: dir, logsDir: dir,
    model: "m", proxyBaseUrl: "http://127.0.0.1:1", timeoutMs: 10_000, ...over,
  };
};
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const fake = (extra: string[] = []) =>
  new PiRunner({ bin: process.execPath, binPrefixArgs: [FAKE, ...extra] });

describe("PiRunner", () => {
  it("runs the fake host, writes the transcript, normalizes events", async () => {
    const task = mkTask();
    const r = await fake().run(task);
    expect(r).toMatchObject({ exitCode: 0, timedOut: false, cancelled: false });
    expect(r.events.map((e) => e.kind)).toEqual(["tool_executed", "tool_executed", "host_event", "host_event"]);
    expect(r.transcriptPath).toBe(join(task.logsDir, "host-transcript.jsonl"));
    expect(readFileSync(r.transcriptPath, "utf8").trim().split("\n")).toHaveLength(4);
  });
  it("propagates a nonzero host exit code", async () => {
    expect((await fake(["--fail"]).run(mkTask())).exitCode).toBe(3);
  });
  it("kills the host on timeout and reports timedOut", async () => {
    const r = await fake(["--sleep", "5000"]).run(mkTask({ timeoutMs: 150 }));
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(-1);
  });
  it("kills the host on AbortSignal and reports cancelled", async () => {
    const ac = new AbortController();
    const p = fake(["--sleep", "5000"]).run(mkTask(), ac.signal);
    setTimeout(() => ac.abort(), 100);
    const r = await p;
    expect(r.cancelled).toBe(true);
    expect(r.timedOut).toBe(false);
  });
  it("passes OPENAI_BASE_URL ending in /v1 derived from proxyBaseUrl", async () => {
    const task = mkTask({ proxyBaseUrl: "http://127.0.0.1:9/" });
    const r = await fake().run(task);
    const envLine = readFileSync(r.transcriptPath, "utf8")
      .trim().split("\n").map((l) => JSON.parse(l))
      .find((o) => o.note === "env");
    expect(envLine.OPENAI_BASE_URL).toBe("http://127.0.0.1:9/v1");
  });
});
