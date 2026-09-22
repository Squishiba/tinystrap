import { describe, expect, it } from "vitest";
import { createToolRegistry } from "@tinystrap/policy";
import { FakeProvider, HARNESS_NOTICE_TOOL, parseSseRecords, startProxy } from "@tinystrap/proxy";
import type { HarnessEvent } from "@tinystrap/policy";
import type { StreamChunk } from "@tinystrap/proxy";

function callStream(n: number): StreamChunk[] {
  const one: StreamChunk =
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c",
      function: { name: "read", arguments: '{"path":"a.ts"}' } }] }, finish_reason: null }] };
  const done: StreamChunk = { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] };
  const out: StreamChunk[] = [];
  for (let i = 0; i < n; i++) out.push(one, done);
  return out;
}

async function post(url: string): Promise<string> {
  const res = await fetch(`${url}/v1/chat/completions`, { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] }) });
  return res.text();
}

function registry() {
  const r = createToolRegistry();
  r.register({ name: "read", description: "read a file", inputSchema: {}, capabilities: [], readOnly: true });
  r.register({ name: HARNESS_NOTICE_TOOL, description: "no-op", inputSchema: {}, capabilities: [], readOnly: true });
  return r;
}

describe("guidance wiring", () => {
  it("stall detection escalates and emits stall_escalated events", async () => {
    const events: HarnessEvent[] = [];
    const proxy = await startProxy({
      provider: new FakeProvider([{ server: "s", attempt: "a", status: 200,
        chunks: callStream(3), summary: {} }]),
      registry: registry(), preflight: () => ({ effect: "allow" }),
      onEvent: (e) => events.push(e),
    });
    const text = await post(proxy.url);
    await proxy.close();
    const stalls = events.filter((e) => e.kind === "stall_escalated");
    expect(stalls.map((e) => e.reason)).toEqual(["nudge:1", "replan:2", "stop:3"]);
    const out = parseSseRecords(text);
    const content = out.map((c) => c.choices[0]?.delta.content ?? "").join("");
    expect(content).toContain("stuck");
    expect(out.some((c) => (c.choices[0]?.delta.tool_calls ?? []).length > 0
      && c.choices[0]!.delta.tool_calls![0].function?.name === HARNESS_NOTICE_TOOL)).toBe(true);
  });
  it("guidance off: no events, raw stream untouched", async () => {
    const events: HarnessEvent[] = [];
    const proxy = await startProxy({
      provider: new FakeProvider([{ server: "s", attempt: "a", status: 200,
        chunks: callStream(3), summary: {} }]),
      registry: registry(), preflight: () => ({ effect: "allow" }),
      onEvent: (e) => events.push(e),
      features: { guidance: false },
    });
    await post(proxy.url);
    await proxy.close();
    expect(events.filter((e) => e.kind === "stall_escalated" || e.kind === "guidance_updated")).toEqual([]);
  });
});
