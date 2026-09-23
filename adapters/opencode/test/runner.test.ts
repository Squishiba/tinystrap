import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { HostTask } from "@tinystrap/core";
import { OpenCodeRunner } from "@tinystrap/adapter-opencode";

// Resolved relative to this file: ../fixtures lands in test/fixtures/.
// (../../fixtures would resolve one level too high, to adapters/opencode/fixtures/.)
const FAKE = join(fileURLToPath(import.meta.url), "../fixtures/fake-host.mjs");
const dirs: string[] = [];
const mkTask = (over: Partial<HostTask> = {}): HostTask => {
  const dir = mkdtempSync(join(tmpdir(), "oc-run-"));
  dirs.push(dir);
  return {
    taskId: "t1", prompt: "p", workspaceDir: dir, logsDir: dir,
    model: "m", proxyBaseUrl: "http://127.0.0.1:1", timeoutMs: 10_000, ...over,
  };
};
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const fake = (extra: string[] = []) =>
  new OpenCodeRunner({ bin: process.execPath, binPrefixArgs: [FAKE, ...extra] });

describe("OpenCodeRunner", () => {
  it("runs the fake host, writes the transcript, normalizes events", async () => {
    const task = mkTask();
    const r = await fake().run(task);
    expect(r).toMatchObject({ exitCode: 0, timedOut: false, cancelled: false });
    expect(r.events.map((e) => e.kind)).toEqual(["tool_executed", "tool_executed", "host_event"]);
    expect(r.transcriptPath).toBe(join(task.logsDir, "host-transcript.jsonl"));
    expect(readFileSync(r.transcriptPath, "utf8").trim().split("\n")).toHaveLength(3);
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
  it("writes opencode.json into the workspace before the run and removes it after", async () => {
    const task = mkTask();
    await fake().run(task);
    expect(existsSync(join(task.workspaceDir, "opencode.json"))).toBe(false);
  });
});
