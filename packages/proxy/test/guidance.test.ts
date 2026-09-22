import { describe, expect, it } from "vitest";
import { parsePlanItems, toolCards, injectGuidance, GuidanceState, GUIDANCE_SENTINEL, STALL_NUDGE, STALL_REPLAN } from "@tinystrap/proxy";
import type { ChatMessage, ToolDefinition, ToolCall } from "@tinystrap/proxy";

const tools: ToolDefinition[] = ["read", "edit", "bash", "grep"].map((n) => ({
  name: n, description: `the ${n} tool`, inputSchema: {}, capabilities: [], readOnly: n === "read" }));

describe("guidance", () => {
  it("parses checklist items and caps at five", () => {
    const items = parsePlanItems("intro\n- [ ] one\n- [x] two\n- [ ] three\n- [ ] four\n- [ ] five\n- [ ] six");
    expect(items).toEqual(["one", "two", "three", "four", "five"]);
    expect(parsePlanItems("no checklist here")).toEqual([]);
  });
  it("toolCards respects the profile limit", () => {
    expect(toolCards(tools, 2)).toEqual(["read: the read tool (read-only)", "edit: the edit tool"]);
  });
  it("injectGuidance replaces, never duplicates, and strips when empty", () => {
    const msgs: ChatMessage[] = [{ role: "system", content: "base" }, { role: "user", content: "go" }];
    const once = injectGuidance(msgs, [`${GUIDANCE_SENTINEL}\nplan please`]);
    const twice = injectGuidance(once, [`${GUIDANCE_SENTINEL}\nnew text`]);
    expect(twice.filter((m) => m.content?.startsWith(GUIDANCE_SENTINEL))).toHaveLength(1);
    expect(twice[1].content).toContain("new text");
    expect(injectGuidance(once, [])).toEqual(msgs);
  });
  it("first submitted plan wins", () => {
    const g = new GuidanceState({ taskId: "t", toolCardLimit: 3 });
    expect(g.hasPlan()).toBe(false);
    g.submitPlan(["a", "b"]);
    g.submitPlan(["c"]);
    expect(g.planItems()).toEqual(["a", "b"]);
    expect(g.requirePlan()).toContain("plan");
  });
});

function call(name: string, args: string): ToolCall {
  return { id: "c", type: "function", function: { name, arguments: args } };
}

describe("stall detection", () => {
  it("detects the third identical call", () => {
    const g = new GuidanceState({ taskId: "t", toolCardLimit: 3 });
    expect(g.recordCalls([call("read", '{"path":"a.ts"}')])).toBe(false);
    expect(g.recordCalls([call("read", '{"path":"a.ts"}')])).toBe(false);
    expect(g.recordCalls([call("read", '{"path":"a.ts"}')])).toBe(true);
  });
  it("detects a reverted edit", () => {
    const g = new GuidanceState({ taskId: "t", toolCardLimit: 3 });
    g.recordCalls([call("edit", '{"path":"a.ts","oldText":"1","newText":"2"}')]);
    g.recordCalls([call("edit", '{"path":"a.ts","oldText":"2","newText":"3"}')]);
    expect(g.recordCalls([call("edit", '{"path":"a.ts","oldText":"3","newText":"2"}')])).toBe(true);
  });
  it("escalates nudge -> replan -> stop", () => {
    const g = new GuidanceState({ taskId: "t", toolCardLimit: 3 });
    expect(g.escalate()).toBe("nudge");
    expect(g.escalate()).toBe("replan");
    expect(g.escalate()).toBe("stop");
    expect(STALL_NUDGE.length).toBeGreaterThan(10);
    expect(STALL_REPLAN.length).toBeGreaterThan(10);
  });
});
