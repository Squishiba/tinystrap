import { describe, expect, it } from "vitest";
import {
  createToolRegistry, evaluate, EvasionTracker, ScriptLedger,
} from "@tinystrap/policy";
import type { PolicyContext, ToolRequest } from "@tinystrap/policy";

const reg = () => {
  const r = createToolRegistry();
  for (const n of ["read", "write", "edit", "bash", "python"]) {
    r.register({ name: n, description: n, inputSchema: {}, capabilities: [], readOnly: false });
  }
  return r;
};

const ctx = (over: Partial<PolicyContext> = {}): PolicyContext => ({
  workspaceRoot: "/task/ws",
  registry: reg(),
  readSet: new Set(["/task/ws/src/a.ts"]),
  exists: () => false,
  realPaths: new Map(),
  ledger: new ScriptLedger(),
  evasion: new EvasionTracker(),
  ...over,
});

const req = (tool: string, args: Record<string, unknown>): ToolRequest =>
  ({ tool, args, cwd: "/task/ws", taskId: "t1", phase: "implementation" });

describe("policy engine", () => {
  it("denies unknown tool", () => {
    const d = evaluate(req("deploy_to_production", {}), ctx());
    expect(d.effect).toBe("deny");
    if (d.effect === "deny") expect(d.reason).toMatch(/^unknown_tool/);
  });
  it("denies phase-forbidden tool", () => {
    const d = evaluate(req("bash", { command: "ls" }),
      ctx({ phaseAllowlists: { implementation: ["read"] } }));
    expect(d.effect).toBe("deny");
    if (d.effect === "deny") expect(d.reason).toMatch(/^phase_denied/);
  });
  it("denies out-of-workspace write", () => {
    const d = evaluate(req("write", { path: "../../etc/hosts" }), ctx());
    expect(d.effect).toBe("deny");
    if (d.effect === "deny") expect(d.reason).toMatch(/outside the task workspace/);
  });
  it("denies existing-file write", () => {
    const d = evaluate(req("write", { path: "src/a.ts" }),
      ctx({ exists: () => true }));
    expect(d.effect).toBe("deny");
  });
  it("denies edit before read", () => {
    const d = evaluate(req("edit", { path: "src/new.ts" }), ctx());
    expect(d.effect).toBe("deny");
    if (d.effect === "deny") expect(d.reason).toContain("not been read");
  });
  it("denies unclassifiable shell (fail closed)", () => {
    const d = evaluate(req("bash", { command: "echo $(pwned)" }), ctx());
    expect(d.effect).toBe("deny");
    if (d.effect === "deny") expect(d.reason).toMatch(/unclassifiable/);
  });
  it("denies git push via bash", () => {
    const d = evaluate(req("bash", { command: "git push origin main" }), ctx());
    expect(d.effect).toBe("deny");
    if (d.effect === "deny") expect(d.reason).toMatch(/git push is forbidden/);
  });
  it("denies dangerous python ast", () => {
    const d = evaluate(req("python", { source: "os.system('rm -rf /')" }),
      ctx({ pythonAst: { nodeType: "Module", body:
        [{ nodeType: "Call", func: "os.system", args: ["rm -rf /"] }] } }));
    expect(d.effect).toBe("deny");
  });
  it("flags evasion on second attempt", () => {
    const evasion = new EvasionTracker();
    const c = ctx({ evasion });
    evaluate(req("write", { path: "../../etc/hosts" }), c);
    // recordDenial happens in the caller; simulate it:
    evasion.recordDenial([{ target: "/etc/hosts", kind: "write", scope: "out_of_workspace" }]);
    const d = evaluate(req("edit", { path: "../../etc/hosts" }),
      { ...c, readSet: new Set(["/etc/hosts"]) });
    expect(d.effect).toBe("deny");
    if (d.effect === "deny") expect(d.reason).toMatch(/evasion_flagged/);
  });
  it("embeds a file slice in read-before-edit denials when readFile is provided", () => {
    const d = evaluate(req("edit", { path: "src/new.ts" }),
      ctx({ readFile: () => "l0\nl1\nl2\nl3\nl4\nl5" }));
    expect(d.effect).toBe("deny");
    if (d.effect === "deny") {
      expect(d.correction).toContain("Current content (from line 1):");
      expect(d.correction).toContain("l2");
    }
  });
  it("allows a clean in-workspace edit", () => {
    expect(evaluate(req("edit", { path: "src/a.ts" }), ctx()))
      .toEqual({ effect: "allow" });
  });

  const driftFile = "alpha\nbeta gamma\ndelta";
  const withFile = (text: string, over: Partial<PolicyContext> = {}): PolicyContext =>
    ctx({ readFile: () => text, ...over });

  it("allows an edit whose oldText matches the file exactly", () => {
    expect(evaluate(req("edit", { path: "src/a.ts", oldText: "beta gamma" }),
      withFile(driftFile))).toEqual({ effect: "allow" });
  });
  it("rewrites oldText when a whitespace-normalized match is unique", () => {
    const d = evaluate(req("edit", { path: "src/a.ts", oldText: "beta   gamma" }),
      withFile(driftFile));
    expect(d.effect).toBe("rewrite");
    if (d.effect === "rewrite")
      expect((d.args as { oldText: string }).oldText).toBe("beta gamma");
  });
  it("denies when the normalized match is ambiguous, listing candidate lines", () => {
    const d = evaluate(req("edit", { path: "src/a.ts", oldText: "same  line" }),
      withFile("same line\nother\nsame line"));
    expect(d.effect).toBe("deny");
    if (d.effect === "deny") {
      expect(d.reason).toContain("several places");
      expect(d.correction).toContain("1, 3");
    }
  });
  it("denies with closest lines when oldText is not found", () => {
    const d = evaluate(req("edit", { path: "src/a.ts", oldText: "beta zzz" }),
      withFile(driftFile));
    expect(d.effect).toBe("deny");
    if (d.effect === "deny") expect(d.correction).toContain("Closest lines:");
  });
  it("skips edit assistance entirely when editAssistance is false", () => {
    expect(evaluate(req("edit", { path: "src/a.ts", oldText: "beta   gamma" }),
      withFile(driftFile, { editAssistance: false }))).toEqual({ effect: "allow" });
  });
});
