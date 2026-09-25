import { describe, expect, it } from "vitest";
import { CORRECTION_SENTINEL, CorrectionStore, injectCorrections, rewriteToolResult } from "@tinystrap/proxy";
import type { ChatMessage } from "@tinystrap/proxy";

describe("CorrectionStore", () => {
  it("caps at max, keeping the newest", () => {
    const s = new CorrectionStore({ max: 2 });
    s.add("a"); s.add("b"); s.add("c");
    expect(s.pending()).toEqual(["b", "c"]);
    s.clear();
    expect(s.pending()).toEqual([]);
  });
});

describe("injectCorrections", () => {
  const history: ChatMessage[] = [
    { role: "system", content: "host prompt" },
    { role: "user", content: "go" },
  ];
  it("inserts a sentinel block after the leading system message", () => {
    const out = injectCorrections(history, ["unknown_tool: `bogus`"]);
    expect(out.length).toBe(3);
    expect(out[1].content!.startsWith(CORRECTION_SENTINEL)).toBe(true);
    expect(out[1].content).toContain("unknown_tool");
  });
  it("replaces the previous block instead of stacking (idempotent per request)", () => {
    const once = injectCorrections(history, ["first"]);
    const twice = injectCorrections(once, ["second"]);
    expect(twice.length).toBe(3);
    expect(twice[1].content).toContain("second");
    expect(twice[1].content).not.toContain("first");
  });
  it("empty corrections strips any stale block", () => {
    const once = injectCorrections(history, ["x"]);
    expect(injectCorrections(once, []).length).toBe(2);
  });
});

describe("rewriteToolResult", () => {
  const history: ChatMessage[] = [
    { role: "assistant", content: "", tool_calls: [{ id: "call_0", type: "function",
      function: { name: "read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_0", content: "original output" },
  ];
  it("replaces the content of the matching tool message only", () => {
    const out = rewriteToolResult(history, "call_0", "Harness: corrected output");
    expect(out[1]).toEqual({ role: "tool", tool_call_id: "call_0",
      content: "Harness: corrected output" });
    expect(out[0]).toBe(history[0]);
  });
  it("leaves history untouched when no call matches", () => {
    expect(rewriteToolResult(history, "call_9", "x")).toEqual(history);
  });
});
