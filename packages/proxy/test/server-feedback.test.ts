import { describe, expect, it } from "vitest";
import { createOpenCodeDialect, createToolRegistry } from "@tinystrap/policy";
import { startProxy } from "@tinystrap/proxy";
import type { ChatRequest, Provider, StreamChunk } from "@tinystrap/proxy";
import { interruptionContentSse } from "@tinystrap/proxy";

class CapturingProvider implements Provider {
  seen: ChatRequest[] = [];
  constructor(private readonly streams: StreamChunk[][]) {}
  async *stream(req: ChatRequest): AsyncIterable<StreamChunk> {
    this.seen.push(req);
    for (const c of this.streams[Math.min(this.seen.length - 1, this.streams.length - 1)]) yield c;
  }
}

const unknownToolStream: StreamChunk[] = [
  { choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_x",
    function: { name: "bogus_tool", arguments: "{}" } }] }, finish_reason: null }] },
];
const textStream: StreamChunk[] = [
  { choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
];

async function post(url: string, body: unknown): Promise<Response> {
  return fetch(`${url}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

describe("interruptionContentSse", () => {
  it("delivers the reason as assistant content with a stop, no harness_notice", () => {
    const sse = interruptionContentSse("unknown_tool: `bogus_tool`");
    expect(sse).toContain("unknown_tool");
    expect(sse).toContain("\"stop\"");
    expect(sse).not.toContain("harness_notice");
  });
});

describe("correction reaches the model via the next request", () => {
  // These tests exercise the interruption_feedback fallback exactly as on main,
  // so the in-stream retry of denied calls is disabled for them (the retry path
  // itself is covered by server-interruption-retry.test.ts).
  const FALLBACK_FEATURES = { interruption_retry: false };

  it("opencode dialect: interrupt responds with content, next request carries the notice block", async () => {
    const provider = new CapturingProvider([unknownToolStream, textStream]);
    const proxy = await startProxy({ provider, registry: createToolRegistry(),
      preflight: () => ({ effect: "allow" }), dialect: createOpenCodeDialect(), taskId: "t",
      features: FALLBACK_FEATURES });
    const first = await (await post(proxy.url, { model: "m", stream: true,
      messages: [{ role: "user", content: "go" }] })).text();
    expect(first).toContain("unknown_tool");
    expect(first).not.toContain("harness_notice");
    await (await post(proxy.url, { model: "m", stream: true,
      messages: [{ role: "user", content: "go" }] })).text();
    await proxy.close();
    const second = provider.seen[1];
    expect(second.messages.some((msg) =>
      msg.role === "system" && (msg.content ?? "").startsWith("--- harness notice ---"))).toBe(true);
    expect(second.messages.find((msg) =>
      (msg.content ?? "").startsWith("--- harness notice ---"))!.content).toContain("bogus_tool");
  });
  it("identity dialect keeps the harness_notice channel (no regression)", async () => {
    const provider = new CapturingProvider([unknownToolStream, textStream]);
    const proxy = await startProxy({ provider, registry: createToolRegistry(),
      preflight: () => ({ effect: "allow" }), taskId: "t",
      features: FALLBACK_FEATURES });
    const first = await (await post(proxy.url, { model: "m", stream: true,
      messages: [{ role: "user", content: "go" }] })).text();
    await proxy.close();
    expect(first).toContain("harness_notice");
  });
  it("feature off: no notice block in the next request", async () => {
    const provider = new CapturingProvider([unknownToolStream, textStream]);
    const proxy = await startProxy({ provider, registry: createToolRegistry(),
      preflight: () => ({ effect: "allow" }), dialect: createOpenCodeDialect(), taskId: "t",
      features: { interruption_feedback: false, ...FALLBACK_FEATURES } });
    await (await post(proxy.url, { model: "m", stream: true,
      messages: [{ role: "user", content: "go" }] })).text();
    await (await post(proxy.url, { model: "m", stream: true,
      messages: [{ role: "user", content: "go" }] })).text();
    await proxy.close();
    expect(provider.seen[1].messages.some((msg) =>
      (msg.content ?? "").startsWith("--- harness notice ---"))).toBe(false);
  });
});
