import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createOpenCodeDialect, createToolRegistry, createIdentityDialect, evaluate,
} from "@tinystrap/policy";
import type { WireTool, ToolRequest } from "@tinystrap/policy";

const fixturePath = fileURLToPath(
  new URL("../../../docs/superpowers/spike-findings/fixtures/opencode-tools.json", import.meta.url));
const hostTools = JSON.parse(readFileSync(fixturePath, "utf8")) as WireTool[];
const dialect = createOpenCodeDialect();

describe("opencode dialect vs the recorded fixture", () => {
  it("the fixture carries the 10 tools from the live check", () => {
    expect(hostTools.map((t) => t.function.name).sort()).toEqual(
      ["bash", "edit", "glob", "grep", "read", "skill", "task", "todowrite", "webfetch", "write"]);
  });
  it("every fixture entry seeds a valid ToolDefinition", () => {
    for (const t of hostTools) {
      const def = dialect.toolDefinition(t);
      expect(def.name).toBe(t.function.name);
      expect(def.description.length).toBeGreaterThan(0);
      expect(Object.keys(def.inputSchema)).toContain("properties");
    }
    expect(dialect.toolDefinition(
      hostTools.find((t) => t.function.name === "read")!).readOnly).toBe(true);
    expect(dialect.toolDefinition(
      hostTools.find((t) => t.function.name === "edit")!).readOnly).toBe(false);
    expect(dialect.toolDefinition(
      hostTools.find((t) => t.function.name === "webfetch")!.function.name === "webfetch"
      ? hostTools.find((t) => t.function.name === "webfetch")!
      : hostTools[0]).capabilities).toContain("network");
  });
  it("edit/read/write/bash argument names normalize to the canonical vocabulary", () => {
    expect(dialect.toCanonicalArgs("edit",
      { filePath: "/w/task/a.txt", oldString: "wrld", newString: "hello world", replaceAll: false }))
      .toEqual({ path: "/w/task/a.txt", oldText: "wrld", newText: "hello world", replaceAll: false });
    expect(dialect.toCanonicalArgs("read", { filePath: "/w/task/a.txt" }))
      .toEqual({ path: "/w/task/a.txt" });
    expect(dialect.toCanonicalArgs("write", { content: "x", filePath: "/w/task/a.txt" }))
      .toEqual({ content: "x", path: "/w/task/a.txt" });
    expect(dialect.toCanonicalArgs("bash", { command: "ls", workdir: "/w/task" }))
      .toEqual({ command: "ls", cwd: "/w/task" });
  });
  it("rewrite args map back to the names OpenCode executes", () => {
    expect(dialect.toHostArgs("edit", { path: "/w/task/a.txt", oldText: "wrld", newText: "x" }))
      .toEqual({ filePath: "/w/task/a.txt", oldString: "wrld", newString: "x" });
  });
  it("v1 dispositions: webfetch/task/skill denied, the rest allowed", () => {
    for (const n of ["webfetch", "task", "skill"]) expect(dialect.disposition(n)).toBe("deny");
    for (const n of ["bash", "edit", "glob", "grep", "read", "todowrite", "write"])
      expect(dialect.disposition(n)).toBe("allow");
  });
  it("overrides flip dispositions (config seam, spec 7 [host.tools])", () => {
    const d = createOpenCodeDialect({ webfetch: "allow" });
    expect(d.disposition("webfetch")).toBe("allow");
    expect(d.disposition("task")).toBe("deny");
  });
  it("the engine sees OpenCode paths after normalization", () => {
    const registry = createToolRegistry();
    for (const t of hostTools) registry.register(dialect.toolDefinition(t));
    const req: ToolRequest = { tool: "read",
      args: dialect.toCanonicalArgs("read", { filePath: "/outside/a.txt" }),
      cwd: "/w/task", taskId: "t", phase: "implementation" };
    const decision = evaluate(req, { workspaceRoot: "/w/task", registry, readSet: new Set(),
      exists: () => false, realPaths: new Map(),
      ledger: { /* ScriptLedger stub not needed: no denial signature */ } as never,
      evasion: { check: () => ({ flagged: false }) } as never });
    expect(decision.effect).toBe("deny");
    expect((decision as { reason: string }).reason).toContain("outside the task workspace");
  });
  it("does not claim the harness_notice channel (live-check 5 Q1 unverified)", () => {
    expect(dialect.supportsHarnessNotice).toBe(false);
    expect(createIdentityDialect().supportsHarnessNotice).toBe(true);
  });
});
