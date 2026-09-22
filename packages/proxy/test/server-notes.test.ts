import { describe, expect, it } from "vitest";
import { createToolRegistry } from "@tinystrap/policy";
import { FakeProvider, HARNESS_NOTICE_TOOL, parseSseRecords, startProxy } from "@tinystrap/proxy";
import type { HarnessEvent } from "@tinystrap/policy";
import type { ChatMessage, ChatRequest, Provider, RecordedStream, StreamChunk } from "@tinystrap/proxy";

function pinStream(name = "pin_note"): RecordedStream[] {
  const chunks: StreamChunk[] = [
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1",
      function: { name, arguments: '{"key":"plan","note":"ship v1"}' } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ];
  return [{ server: "s", attempt: "a", status: 200, chunks, summary: {} }];
}

async function post(url: string, body: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${url}/v1/chat/completions`, { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m", stream: true,
      messages: [{ role: "user", content: "hi" }], ...body }) });
  return res.text();
}

describe("pin_note through the server", () => {
  it("executes the note call, emits tool_executed, rewrites to harness_notice", async () => {
    const events: HarnessEvent[] = [];
    const proxy = await startProxy({
      provider: new FakeProvider(pinStream()), registry: createToolRegistry(),
      preflight: () => ({ effect: "allow" }), onEvent: (e) => events.push(e),
    });
    const text = await post(proxy.url, {});
    await proxy.close();
    expect(events.some((e) => e.kind === "tool_executed" && e.tool === "pin_note")).toBe(true);
    const out = parseSseRecords(text);
    const names = out.flatMap((c) => c.choices[0]?.delta.tool_calls ?? [])
      .map((d) => d.function?.name);
    expect(names).toEqual([HARNESS_NOTICE_TOOL]); // raw pin_note never reaches the host
  });
  it("re-injects the pinned block into the next request on the same instance", async () => {
    const seen: ChatMessage[][] = [];
    const inner = new FakeProvider([...pinStream(), ...pinStream()]); // pin runs on both requests
    const spy: Provider = {
      async *stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamChunk> {
        seen.push(req.messages);
        yield* inner.stream(req, signal);
      },
    };
    const proxy = await startProxy({ provider: spy, registry: createToolRegistry(),
      preflight: () => ({ effect: "allow" }) });
    await post(proxy.url, {});
    await post(proxy.url, {});
    await proxy.close();
    const pinned = (msgs: ChatMessage[]) => msgs.filter((m) =>
      m.role === "system" && m.content?.startsWith("--- pinned notes")).length;
    expect(pinned(seen[0])).toBe(0);  // store empty on the first request
    expect(pinned(seen[1])).toBe(1);  // first call pinned "plan" → re-injected (spec 12.7)
    expect(seen[1].find((m) => m.content?.startsWith("--- pinned notes"))!.content)
      .toContain("plan: ship v1");
  });
});