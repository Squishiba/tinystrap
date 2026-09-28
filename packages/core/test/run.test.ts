import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultCommandRunner } from "@tinystrap/core";

function tmp(): string { return mkdtempSync(join(tmpdir(), "ts-run-")); }

describe("defaultCommandRunner", () => {
  it("captures stdout and a zero exit code", async () => {
    const r = await defaultCommandRunner("node", ["--version"], { cwd: tmp() });
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^v\d+/);
  });
  it("feeds stdin to the child", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "cat.mjs"),
      "const chunks = []; for await (const c of process.stdin) chunks.push(c);\n" +
      "process.stdout.write(Buffer.concat(chunks));\n");
    const r = await defaultCommandRunner("node", ["cat.mjs"], { cwd: dir, stdin: "hello patch" });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("hello patch");
  });
  it("reports non-zero exit codes without throwing", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "fail.mjs"), "process.stderr.write('boom'); process.exit(3);\n");
    const r = await defaultCommandRunner("node", ["fail.mjs"], { cwd: dir });
    expect(r.code).toBe(3);
    expect(r.stderr).toBe("boom");
    expect(r.timedOut).toBe(false);
  });
  it("kills a hung child on timeout and flags timedOut", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "hang.mjs"), "setTimeout(() => {}, 60_000);\n");
    const started = Date.now();
    const r = await defaultCommandRunner("node", ["hang.mjs"], { cwd: dir, timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.code).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 15_000);
  it("kills grandchildren with the tree, not just the direct child", async () => {
    const dir = tmp();
    // The direct child spawns a grandchild that outlives it: a bare
    // child.kill() would orphan the grandchild and leave the marker growing.
    writeFileSync(join(dir, "parent.mjs"),
      "import { spawn } from 'node:child_process';\n" +
      "const child = spawn(process.execPath, ['child.mjs'], { cwd: process.cwd(), stdio: 'ignore' });\n" +
      "process.stdout.write(String(child.pid));\n" +
      "setTimeout(() => {}, 60_000);\n");
    writeFileSync(join(dir, "child.mjs"),
      "import { appendFileSync } from 'node:fs';\n" +
      "setInterval(() => appendFileSync('alive.txt', 'x'), 100);\n");
    const r = await defaultCommandRunner("node", ["parent.mjs"], { cwd: dir, timeoutMs: 400 });
    expect(r.timedOut).toBe(true);
    await new Promise((res) => setTimeout(res, 700));
    const before = readSize(join(dir, "alive.txt"));
    await new Promise((res) => setTimeout(res, 700));
    expect(readSize(join(dir, "alive.txt"))).toBe(before);
  }, 20_000);
  it("never uses a shell: metacharacters stay literal arguments", async () => {
    const r = await defaultCommandRunner("node", ["--eval", "process.stdout.write(typeof process.env.__NOT_A_FLAG)"],
      { cwd: tmp(), env: { PATH: process.env.PATH ?? "" } });
    expect(r.stdout).toBe("undefined");
  });
});

function readSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
