import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createTask, extractPatch, runVerifyCommand, snapshotGit,
  splitVerifyCommand, verifyInFreshWorkspace,
} from "@tinystrap/core";

function tmp(): string { return mkdtempSync(join(tmpdir(), "ts-vrun-")); }

describe("splitVerifyCommand", () => {
  it("splits a plain program invocation", () => {
    expect(splitVerifyCommand("go test ./...")).toEqual(["go", "test", "./..."]);
  });
  it("rejects shell metacharacters", () => {
    for (const bad of ["echo hi; rm -rf /", "cat a | sh", "make ${TARGET}", "pytest > out.txt",
      "cargo test && curl example.invalid", "node `whoami`", "npx vitest"]) {
      expect(() => splitVerifyCommand(bad)).toThrow(/metacharacter|not a plain|single plain/);
    }
  });
  it("rejects an empty command", () => {
    expect(() => splitVerifyCommand("   ")).toThrow(/empty/);
  });
});

describe("runVerifyCommand", () => {
  it("runs a script and captures its exit code", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "ok.mjs"), "process.stdout.write('ran');\n");
    const r = await runVerifyCommand({ name: "ok", command: "node ok.mjs" }, dir);
    expect(r).toMatchObject({ name: "ok", exitCode: 0, timedOut: false, outputTail: "ran" });
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });
  it("keeps only the bounded tail of loud output", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "loud.mjs"),
      "for (let i = 0; i < 2000; i++) process.stdout.write(`line-` + i + `\\n`);\n");
    const r = await runVerifyCommand(
      { name: "loud", command: "node loud.mjs" }, dir, { outputTailChars: 200 });
    expect(r.outputTail.length).toBeLessThanOrEqual(200);
    expect(r.outputTail).toContain("line-1999");
  });
  it("times out with the tree-kill runner and says so in the tail", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "hang.mjs"), "setTimeout(() => {}, 60_000);\n");
    const r = await runVerifyCommand(
      { name: "hang", command: "node hang.mjs" }, dir, { timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).not.toBe(0);
    expect(r.outputTail).toContain("timed out");
  }, 15_000);
});

describe("verifyInFreshWorkspace", () => {
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
  };

  // Real git project + task + baseline, then a simulated model edit to a.txt
  // (the patch.test.ts pattern). check.mjs ships in the BASELINE, so the
  // harness-side script runs against the patched fresh copy.
  async function projectWithEdit(checkBody: string) {
    const root = mkdtempSync(join(tmpdir(), "ts-vfresh-"));
    const g = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: "pipe", env: gitEnv });
    g("init", "-b", "main");
    writeFileSync(join(root, "a.txt"), "one\n");
    writeFileSync(join(root, "check.mjs"), checkBody);
    g("add", ".");
    g("commit", "-m", "init");
    const handle = await createTask(root);
    const baseline = await snapshotGit(root, handle);
    writeFileSync(join(handle.workspaceDir, "a.txt"), "two\n");
    const patch = await extractPatch(handle);
    return { root, handle, baseline, patch };
  }

  // git checkout normalizes line endings per core.autocrlf on Windows, so the
  // fresh copy's a.txt may read back as "two\r\n" there (same as patch.test.ts).
  const PASSES = "import { readFileSync } from 'node:fs';\n" +
    "process.exit(readFileSync('a.txt', 'utf8').replace(/\\r\\n/g, '\\n') === 'two\\n' ? 0 : 1);\n";

  type EventLike = { kind: string; taskId: string; decision?: string };

  it("applies the patch to a fresh baseline copy and runs the checks there", async () => {
    const { handle, baseline, patch } = await projectWithEdit(PASSES);
    const events: EventLike[] = [];
    const report = await verifyInFreshWorkspace(handle, baseline, patch,
      [{ name: "check", command: "node check.mjs" }],
      { onEvent: (e) => events.push(e) });

    expect(report.apply.ok).toBe(true);
    expect(report.passed).toBe(true);
    expect(report.results).toHaveLength(1);
    expect(report.results[0]).toMatchObject({ name: "check", exitCode: 0, timedOut: false });
    expect(report.patchHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(events.map((e) => e.kind)).toEqual(["verification_started", "verification_finished"]);
    expect(events.every((e) => e.taskId === handle.taskId)).toBe(true);
    expect(events[1].decision).toBe("pass");
  }, 60_000);

  it("runs the checks in a harness-owned verify dir, never in the model workspace", async () => {
    const { handle, baseline, patch } = await projectWithEdit(
      "import { writeFileSync } from 'node:fs';\nwriteFileSync('marker.txt', 'ran');\n");
    const report = await verifyInFreshWorkspace(handle, baseline, patch,
      [{ name: "check", command: "node check.mjs" }]);

    expect(report.passed).toBe(true);
    const dirs = readdirSync(handle.taskDir).filter((n) => n.startsWith("verify-"));
    expect(dirs).toHaveLength(1);
    expect(existsSync(join(handle.taskDir, dirs[0], "marker.txt"))).toBe(true);
    expect(existsSync(join(handle.workspaceDir, "marker.txt"))).toBe(false);
    // The fresh copy is the baseline revision plus the extracted patch.
    // (git checkout may normalize line endings per core.autocrlf on Windows.)
    expect(readFileSync(join(handle.taskDir, dirs[0], "a.txt"), "utf8").replace(/\r\n/g, "\n"))
      .toBe("two\n");
    // ...and it is not wired to the protected project: nothing can push from here.
    expect(execFileSync("git", ["remote", "-v"],
      { cwd: join(handle.taskDir, dirs[0]), stdio: "pipe" }).toString().trim()).toBe("");
  }, 60_000);

  it("fails when a check fails, keeping the failure tail", async () => {
    const { handle, baseline, patch } = await projectWithEdit(
      "import { readFileSync } from 'node:fs';\n" +
      "process.stderr.write('expected three, got ' + readFileSync('a.txt', 'utf8').trim() + '\\n');\n" +
      "process.exit(1);\n");
    const report = await verifyInFreshWorkspace(handle, baseline, patch,
      [{ name: "check", command: "node check.mjs" }]);

    expect(report.passed).toBe(false);
    expect(report.results).toHaveLength(1);
    expect(report.results[0].exitCode).toBe(1);
    expect(report.results[0].outputTail).toContain("expected three");
  }, 60_000);

  it("reports apply failure without running any command", async () => {
    const { handle, baseline } = await projectWithEdit(PASSES);
    const events: EventLike[] = [];
    const report = await verifyInFreshWorkspace(handle, baseline, "-nope\n",
      [{ name: "check", command: "node check.mjs" }], { onEvent: (e) => events.push(e) });

    expect(report.apply.ok).toBe(false);
    expect(report.passed).toBe(false);
    expect(report.results).toEqual([]);
    expect(report.apply.outputTail.trim()).not.toBe("");
    expect(events.map((e) => e.kind)).toEqual(["verification_started", "verification_finished"]);
    expect(events[1].decision).toBe("fail");
  }, 60_000);

  it("refuses a manifest baseline with an actionable message", async () => {
    const { handle, baseline, patch } = await projectWithEdit(PASSES);
    await expect(verifyInFreshWorkspace(handle, { ...baseline, revision: "manifest:abc" }, patch,
      [{ name: "check", command: "node check.mjs" }])).rejects.toThrow(/git project/);
  }, 60_000);

  it("flags a timed-out check and continues to the report", async () => {
    const { handle, baseline, patch } = await projectWithEdit("setTimeout(() => {}, 60_000);\n");
    const report = await verifyInFreshWorkspace(handle, baseline, patch,
      [{ name: "check", command: "node check.mjs" }], { timeoutMs: 300 });

    expect(report.results).toHaveLength(1);
    expect(report.results[0].timedOut).toBe(true);
    expect(report.passed).toBe(false);
  }, 30_000);

  it("treats an empty command list as not verified", async () => {
    const { handle, baseline, patch } = await projectWithEdit(PASSES);
    const report = await verifyInFreshWorkspace(handle, baseline, patch, []);

    expect(report.apply.ok).toBe(true);
    expect(report.results).toEqual([]);
    expect(report.passed).toBe(false);
  }, 60_000);

  it("bounds the apply output tail", async () => {
    const { handle, baseline } = await projectWithEdit(PASSES);
    const report = await verifyInFreshWorkspace(handle, baseline, "-nope\n", [],
      { outputTailChars: 20 });

    expect(report.apply.ok).toBe(false);
    expect(report.apply.outputTail.length).toBeLessThanOrEqual(20);
    expect(report.apply.outputTail.length).toBeGreaterThan(0);
  }, 60_000);
});
