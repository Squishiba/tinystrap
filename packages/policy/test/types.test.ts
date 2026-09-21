import { describe, expect, it } from "vitest";
import type { EffectRecord, PolicyDecision, ToolRequest } from "@tinystrap/policy";

describe("policy types", () => {
  it("constructs an effect record", () => {
    const e: EffectRecord = { target: "src/a.ts", kind: "write", scope: "in_workspace" };
    expect(e.kind).toBe("write");
  });
  it("constructs a deny decision", () => {
    const d: PolicyDecision = { effect: "deny", reason: "r", retryable: false };
    const r: ToolRequest = { tool: "edit", args: {}, cwd: "/", taskId: "t1", phase: "implementation" };
    expect([d.effect, r.phase]).toEqual(["deny", "implementation"]);
  });
});
