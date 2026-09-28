import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { splitVerifyCommand, runVerifyCommand } from "@tinystrap/core";

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
