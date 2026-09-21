import { describe, expect, it } from "vitest";
import type { StreamChunk } from "@tinystrap/proxy";
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
  it("always forwards content and reasoning deltas", () => {
    const gate = gateForTest();
    expect(gate.push(chunk({ reasoning_content: "hmm" })).kind).toBe("forward");
    expect(gate.push(chunk({ content: "text" })).kind).toBe("forward");
  });
});
