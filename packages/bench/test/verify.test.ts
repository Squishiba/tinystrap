import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
