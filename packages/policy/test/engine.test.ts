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
  it("allows a clean in-workspace edit", () => {
    expect(evaluate(req("edit", { path: "src/a.ts" }), ctx()))
      .toEqual({ effect: "allow" });
  });
});
