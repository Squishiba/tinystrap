import { describe, expect, it } from "vitest";
import { createOpenCodeDialect, createToolRegistry } from "@tinystrap/policy";
import type { PolicyDecision, WireTool } from "@tinystrap/policy";
import type { StreamChunk } from "@tinystrap/proxy";
import { seedRegistry, StreamGate } from "@tinystrap/proxy";
import { gateForTest } from "./helpers.js";

const chunk = (delta: StreamChunk["choices"][0]["delta"],
  finish: string | null = null): StreamChunk =>
  ({ choices: [{ index: 0, delta, finish_reason: finish }] });

describe("stream gate", () => {
  it("interrupts at the first name-bearing chunk for unknown tools", () => {
    const gate = gateForTest();
    const actions = [
      gate.push(chunk({ role: "assistant" })),
      gate.push(chunk({ tool_calls: [{ index: 0, id: "c1",
        function: { name: "deploy_prod", arguments: "{" } }] })),
    ];
    expect(actions[0].kind).toBe("forward");
    expect(actions[1].kind).toBe("interrupt");
    if (actions[1].kind === "interrupt") {
      expect(actions[1].reason).toMatch(/^unknown_tool/);
      expect(actions[1].tool).toBe("deploy_prod");
    }
  });
  it("interrupts when complete arguments are denied", () => {
    const gate = gateForTest({ effect: "deny", reason: "outside workspace", retryable: true });
    gate.push(chunk({ tool_calls: [{ index: 0, id: "c1",
      function: { name: "write", arguments: '{"path":' } }] }));
    const a = gate.push(chunk({ tool_calls: [{ index: 0,
      function: { arguments: '"/etc/hosts"}' } }] }));
    expect(a.kind).toBe("interrupt");
    if (a.kind === "interrupt") expect(a.reason).toBe("outside workspace");
  });
  it("forwards a fully allowed call and accumulates it", () => {
    const gate = gateForTest();
    gate.push(chunk({ tool_calls: [{ index: 0, id: "c1",
      function: { name: "read", arguments: '{"path":"a.ts"}' } }] }));
    const a = gate.push(chunk({}, "tool_calls"));
    expect(a.kind).toBe("forward");
    expect(gate.accumulated()).toEqual([
      { id: "c1", type: "function",
        function: { name: "read", arguments: '{"path":"a.ts"}' } },
    ]);
  });
  it("applies a rewrite decision to the buffered arguments", () => {
    const gate = gateForTest({ effect: "rewrite", args: { path: "a.ts", oldText: "fixed" },
      reason: "edit_assistance" });
    const chunks = [
      chunk({ tool_calls: [{ index: 0, id: "c1",
        function: { name: "edit", arguments: '{"path":"a.ts","oldText":"broken"}' } }] }),
      chunk({}, "tool_calls"),
    ];
    for (const c of chunks) expect(gate.push(c).kind).toBe("forward");
    expect(JSON.parse(gate.accumulated()[0].function.arguments).oldText).toBe("fixed");
  });
  it("always forwards content and reasoning deltas", () => {
    const gate = gateForTest();
    expect(gate.push(chunk({ reasoning_content: "hmm" })).kind).toBe("forward");
    expect(gate.push(chunk({ content: "text" })).kind).toBe("forward");
  });
});

function toolCallChunk(index: number, id: string, name: string, args: string): StreamChunk {
  return { choices: [{ index: 0,
    delta: { role: "assistant", tool_calls: [{ index, id, function: { name, arguments: args } }] },
    finish_reason: null }] };
}

const opencodeTools: WireTool[] = [
  { type: "function", function: { name: "edit", parameters: {} } },
  { type: "function", function: { name: "webfetch", parameters: {} } },
];

function opencodeGate(decision: PolicyDecision, seen: Array<{ tool: string; args: Record<string, unknown> }>) {
  const registry = createToolRegistry();
  seedRegistry(registry, opencodeTools, createOpenCodeDialect());
  return new StreamGate({ registry, dialect: createOpenCodeDialect(),
    preflight: (tool, args) => { seen.push({ tool, args }); return decision; } });
}

describe("StreamGate with the OpenCode dialect", () => {
  it("preflight sees canonical args, not filePath/oldString", () => {
    const seen: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const gate = opencodeGate({ effect: "allow" }, seen);
    gate.push(toolCallChunk(0, "call_1", "edit",
      "{\"filePath\":\"/w/task/a.txt\",\"oldString\":\"wrld\",\"newString\":\"x\"}"));
    expect(gate.push(toolCallChunk(0, "call_1", "", "}"))).toEqual(
      expect.objectContaining({ kind: "forward" }));
    expect(seen[0].args).toEqual({ path: "/w/task/a.txt", oldText: "wrld", newText: "x" });
  });
  it("a rewrite decision is mapped back to host argument names", () => {
    const seen: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const gate = opencodeGate(
      { effect: "rewrite", reason: "edit_assistance",
        args: { path: "/w/task/a.txt", oldText: "wrld exact", newText: "x" } }, seen);
    gate.push(toolCallChunk(0, "call_1", "edit", "{\"filePath\":\"/w/task/a.txt\""));
    gate.push(toolCallChunk(0, "call_1", "", ",\"oldString\":\"wrld\",\"newString\":\"x\"}"));
    const [call] = gate.accumulated();
    expect(JSON.parse(call.function.arguments)).toEqual({
      filePath: "/w/task/a.txt", oldString: "wrld exact", newString: "x" });
  });
  it("a denied disposition trips with host_denied before preflight runs", () => {
    const seen: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const gate = opencodeGate({ effect: "allow" }, seen);
    const action = gate.push(toolCallChunk(0, "call_9", "webfetch", "{\"url\":\"https://example.invalid\"}"));
    expect(action.kind).toBe("interrupt");
    expect((action as { reason: string }).reason).toContain("host_denied");
    expect(seen.length).toBe(0);
  });
});
