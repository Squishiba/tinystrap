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

  // Process-tree tests: the fake host spawns a grandchild that inherits stdout.
  // Killing only the direct child leaves the grandchild holding the pipe, so
  // `close` never fires and run() never resolves — these prove the whole tree
  // dies and the run settles promptly with a partial (incremental) transcript.
  const isDead = (pid: number): boolean => {
    try { process.kill(pid, 0); return false; }
    catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH"; }
  };
  const waitForDead = async (pid: number, timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (isDead(pid)) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return isDead(pid);
  };
  const trackedPids: number[] = [];
  afterEach(async () => {
    for (const pid of trackedPids.splice(0)) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
    }
  });
  // The transcript is byte-faithful raw stdout: a run killed mid-write may
  // legitimately end on a partial line, so parse line-by-line and skip
  // fragments instead of JSON.parse-ing every line (that threw
  // "Unexpected end of JSON input" on empty/partial transcripts).
  const transcriptObjects = (transcriptPath: string): Array<{ type?: string; pid?: number; note?: string }> => {
    let text = "";
    try { text = readFileSync(transcriptPath, "utf8"); } catch { return []; }
    return text.split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((o) => o !== null);
  };
  const grandchildPid = (transcriptPath: string): number => {
    const line = transcriptObjects(transcriptPath).find((o) => o.type === "grandchild");
    expect(line, "transcript must contain the grandchild line printed before the kill").toBeTruthy();
    trackedPids.push(line.pid!);
    return line.pid!;
  };

  // Regression: killAndArmFallback used to destroy() the stdout stream at
  // kill time, discarding bytes the host had already written into the OS
  // pipe but the parent had not yet read — the "partial transcript" silently
  // lost data written before the kill. The event loop is blocked here until
  // the host confirms (via host-ready) that its synchronous line is in the
  // pipe, so the kill provably lands with unread pipe data in flight.
  it("keeps bytes already in the stdout pipe when the timeout kill lands", async () => {
    const task = mkTask({ timeoutMs: 300 });
    const p = fake(["--syncline"]).run(task);
    const hard = Date.now() + 10_000;
    // Synchronous poll: no event-loop turns, so no data events can drain
    // the pipe before the kill.
    while (!existsSync(join(task.logsDir, "host-ready"))) {
      if (Date.now() > hard) throw new Error("fake host never wrote its synchronous line");
    }
    const r = await p;
    expect(r.timedOut).toBe(true);
    expect(transcriptObjects(r.transcriptPath).filter((o) => o.note === "syncline")).toHaveLength(1);
  }, 15_000);

  it("kills the whole process tree on timeout and settles promptly with a partial transcript", async () => {
    const task = mkTask({ timeoutMs: 2_000 });
    const start = Date.now();
    const r = await fake(["--grandchild"]).run(task);
    // Bound is relative to the kill: the assertion is about settling
    // promptly after the timeout fires, not about the absolute deadline.
    expect(Date.now() - start, "run() must settle within ~2.5 s of the kill").toBeLessThan(task.timeoutMs + 2_500);
    expect(r.timedOut).toBe(true);
    expect(r.cancelled).toBe(false);
    expect(r.exitCode).toBe(-1);
    expect(existsSync(r.transcriptPath)).toBe(true);
    const gcPid = grandchildPid(r.transcriptPath);
    expect(await waitForDead(gcPid, 3_000), `grandchild ${gcPid} survived the timeout kill`).toBe(true);
  }, 15_000);

  it("kills the whole process tree on AbortSignal and settles promptly", async () => {
    const task = mkTask({ timeoutMs: 30_000 });
    const transcriptPath = join(task.logsDir, "host-transcript.jsonl");
    const ac = new AbortController();
    const p = fake(["--grandchild"]).run(task, ac.signal);
    // Deterministic kill point: abort only once the grandchild line has
    // reached the transcript. A fixed abort delay raced host process startup
    // on loaded runners and killed the host before its line was written.
    const hard = Date.now() + 10_000;
    while (!transcriptObjects(transcriptPath).some((o) => o.type === "grandchild")) {
      if (Date.now() > hard) throw new Error("grandchild line never reached the transcript");
      await new Promise((res) => setTimeout(res, 25));
    }
    const abortAt = Date.now();
    ac.abort();
    const r = await p;
    expect(Date.now() - abortAt, "run() must settle within ~5 s of the abort").toBeLessThan(5_000);
    expect(r.cancelled).toBe(true);
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(-1);
    const gcPid = grandchildPid(r.transcriptPath);
    expect(await waitForDead(gcPid, 3_000), `grandchild ${gcPid} survived the abort kill`).toBe(true);
  }, 20_000);
});
