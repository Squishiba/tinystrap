import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTask, extractPatch, snapshotGit } from "@tinystrap/core";
import { verifyInFreshCopy } from "@tinystrap/bench";

let root: string;

const PATCH_1_TO_2 = [
  "diff --git a/a.txt b/a.txt",
  "--- a/a.txt",
  "+++ b/a.txt",
  "@@ -1 +1 @@",
  "-1",
  "+2",
  "",
].join("\n");

const PATCH_2_TO_1 = [
  "diff --git a/a.txt b/a.txt",
  "--- a/a.txt",
  "+++ b/a.txt",
  "@@ -1 +1 @@",
  "-2",
  "+1",
  "",
].join("\n");

const HIDDEN_TEST = [
  'import { test } from "node:test";',
  'import assert from "node:assert/strict";',
  'import { readFileSync } from "node:fs";',
  'test("a.txt holds the patched content", () => {',
  '  assert.equal(readFileSync("a.txt", "utf8").trim(), "2");',
  "});",
  "",
].join("\n");

function makeCase(name: string, fileContent: string): { fixture: string; hidden: string } {
  const base = join(root, name);
  const fixture = join(base, "fixture");
  const hidden = join(base, "verify");
  mkdirSync(fixture, { recursive: true });
  mkdirSync(hidden, { recursive: true });
  writeFileSync(join(fixture, "a.txt"), fileContent);
  writeFileSync(join(hidden, "test.mjs"), HIDDEN_TEST);
  return { fixture, hidden };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "bench-verify-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("verifyInFreshCopy", () => {
  it("passes when the patch makes the hidden test pass", async () => {
    const { fixture, hidden } = makeCase("apply-ok", "1\n");
    const result = await verifyInFreshCopy(fixture, PATCH_1_TO_2, hidden, "node --test test.mjs");
    expect(result.passed).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it("fails when the patch does not apply (reverted patch)", async () => {
    const { fixture, hidden } = makeCase("apply-fail", "1\n");
    const result = await verifyInFreshCopy(fixture, PATCH_2_TO_1, hidden, "node --test test.mjs");
    expect(result.passed).toBe(false);
  });

  it("treats an empty patch as a no-op on an already-correct fixture", async () => {
    const { fixture, hidden } = makeCase("empty-patch", "2\n");
    const result = await verifyInFreshCopy(fixture, "", hidden, "node --test test.mjs");
    expect(result.passed).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it("throws on a command with shell metacharacters before spawning", async () => {
    const { fixture, hidden } = makeCase("metachars", "2\n");
    await expect(
      verifyInFreshCopy(fixture, "", hidden, "node --test test.mjs; echo done"),
    ).rejects.toThrow(/metacharacter/);
  });

  it("does not modify the pristine fixture", async () => {
    const { fixture } = makeCase("pristine", "1\n");
    await verifyInFreshCopy(fixture, PATCH_1_TO_2, null, "node --version");
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(join(fixture, "a.txt"), "utf8")).toBe("1\n");
  });

  it("reports a clear failure message when a patch does not apply", async () => {
    const { fixture, hidden } = makeCase("apply-msg", "1\n");
    const result = await verifyInFreshCopy(fixture, PATCH_2_TO_1, hidden, "node --test test.mjs");
    expect(result.passed).toBe(false);
    expect(result.outputTail).toContain("patch does not apply");
  });

  it("round-trips a text patch produced by core extractPatch", async () => {
    const base = mkdtempSync(join(tmpdir(), "bench-verify-rt-"));
    const proj = join(base, "proj");
    mkdirSync(proj, { recursive: true });
    gitIn(proj, "init", "-b", "main");
    writeFileSync(join(proj, "a.txt"), "1\n");
    gitIn(proj, "add", ".");
    gitIn(proj, "commit", "-m", "init");
    const h = await createTask(proj);
    await snapshotGit(proj, h);
    writeFileSync(join(h.workspaceDir, "a.txt"), "2\n");
    const patch = await extractPatch(h);
    const { hidden } = makeCase("roundtrip", "1\n");
    const result = await verifyInFreshCopy(proj, patch, hidden, "node --test test.mjs");
    expect(result.passed).toBe(true);
    rmSync(h.taskDir, { recursive: true, force: true });
  }, 60_000);

  it("applies a binary patch produced by core extractPatch", async () => {
    const base = mkdtempSync(join(tmpdir(), "bench-verify-bin-"));
    const proj = join(base, "proj");
    mkdirSync(proj, { recursive: true });
    gitIn(proj, "init", "-b", "main");
    writeFileSync(join(proj, "logo.bin"), Buffer.from([1, 2, 0, 255]));
    gitIn(proj, "add", ".");
    gitIn(proj, "commit", "-m", "init");
    const h = await createTask(proj);
    await snapshotGit(proj, h);
    writeFileSync(join(h.workspaceDir, "logo.bin"), Buffer.from([9, 8, 0, 7, 0xfe]));
    const patch = await extractPatch(h);
    expect(patch).toContain("GIT binary patch");
    const result = await verifyInFreshCopy(proj, patch, null, "git status");
    expect(result.outputTail).not.toContain("cannot apply binary patch");
    expect(result.passed).toBe(true);
    rmSync(h.taskDir, { recursive: true, force: true });
  }, 60_000);
});

// Git identity via IDENT env vars so no identity flags appear in sources.
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_IDENT: "t <t@t>",
  GIT_COMMITTER_IDENT: "t <t@t>",
};
const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv });
