import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { killProcessTree } from "@tinystrap/core";

// A long-lived grandchild script: sleeps 60 s so any survival is observable.
const GRANDCHILD_SRC = "setTimeout(() => {}, 60_000);";
// Child script: spawns the grandchild (same stdio group), prints its pid, sleeps.
const CHILD_SRC = `
const { spawn } = require("node:child_process");
const gc = spawn(process.execPath, ["-e", ${JSON.stringify(GRANDCHILD_SRC)}], { stdio: "ignore" });
process.stdout.write(String(gc.pid));
setTimeout(() => {}, 60_000);
`;

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

const leftovers: number[] = [];
const spawned: ChildProcess[] = [];

afterEach(async () => {
  for (const p of spawned.splice(0)) { try { p.kill("SIGKILL"); } catch { /* already dead */ } }
  for (const pid of leftovers.splice(0)) killProcessTree(pid);
});

describe("killProcessTree", () => {
  it("kills the child and its grandchild within 3 seconds", async () => {
    const child = spawn(process.execPath, ["-e", CHILD_SRC], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    spawned.push(child);

    const gcPid = await new Promise<number>((resolve, reject) => {
      let buf = "";
      child.stdout.on("data", (d: Buffer) => {
        buf += d.toString();
        const pid = Number(buf.trim());
        if (Number.isInteger(pid) && pid > 0) resolve(pid);
      });
      child.on("error", reject);
      setTimeout(() => reject(new Error(`grandchild pid not printed (got "${buf}")`)), 5_000);
    });
    leftovers.push(gcPid);

    killProcessTree(child.pid);
    leftovers.push(child.pid);

    const [childDead, gcDead] = await Promise.all([
      waitForDead(child.pid, 3_000),
      waitForDead(gcPid, 3_000),
    ]);
    expect(childDead, `child ${child.pid} still alive`).toBe(true);
    expect(gcDead, `grandchild ${gcPid} still alive`).toBe(true);
  }, 15_000);

  it("never throws for an invalid or already-dead pid", () => {
    expect(() => killProcessTree(-1)).not.toThrow();
    expect(() => killProcessTree(2 ** 31 - 1)).not.toThrow();
  });
});
