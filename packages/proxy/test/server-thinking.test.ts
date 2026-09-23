import { describe, expect, it } from "vitest";
import { createToolRegistry } from "@tinystrap/policy";
import { FakeProvider, startProxy } from "@tinystrap/proxy";
import type { ChatRequest, Provider, StreamChunk } from "@tinystrap/proxy";

class SpyProvider implements Provider {
  seen: ChatRequest[] = [];
  constructor(private readonly inner: Provider) {}
  async *stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamChunk> {
    this.seen.push(req);
    yield* this.inner.stream(req, signal);
  }
}

const quiet: StreamChunk[] = [
  { choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
];
const caps = { supports_tools: true };

async function post(proxyUrl: string, body: Record<string, unknown>): Promise<void> {
  await fetch(`${proxyUrl}/v1/chat/completions`, { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "qwen3-test", stream: true,
      messages: [{ role: "user", content: "hi" }], ...body }) });
}

describe("phase thinking wiring", () => {
  it("mechanical phase sends enable_thinking false", async () => {
    const spy = new SpyProvider(new FakeProvider(
      [{ server: "s", attempt: "a", status: 200, chunks: quiet, summary: {} }]));
    const proxy = await startProxy({ provider: spy, registry: createToolRegistry(),
      preflight: () => ({ effect: "allow" }), serverCaps: caps, phase: () => "implementation" });
    await post(proxy.url, {});
    await proxy.close();
    expect(spy.seen[0].chat_template_kwargs).toEqual({ enable_thinking: false });
  });
  it("planning phase sends enable_thinking true", async () => {
    const spy = new SpyProvider(new FakeProvider(
      [{ server: "s", attempt: "a", status: 200, chunks: quiet, summary: {} }]));
    const proxy = await startProxy({ provider: spy, registry: createToolRegistry(),
      preflight: () => ({ effect: "allow" }), serverCaps: caps, phase: () => "planning" });
    await post(proxy.url, {});
    await proxy.close();
    expect(spy.seen[0].chat_template_kwargs).toEqual({ enable_thinking: true });
  });
  it("no caps means no kwargs injected; caller kwargs survive", async () => {
    const spy = new SpyProvider(new FakeProvider(
      [{ server: "s", attempt: "a", status: 200, chunks: quiet, summary: {} }]));
    const proxy = await startProxy({ provider: spy, registry: createToolRegistry(),
      preflight: () => ({ effect: "allow" }), serverCaps: null, phase: () => "implementation" });
    await post(proxy.url, { chat_template_kwargs: { enable_thinking: true } });
    await proxy.close();
    expect(spy.seen[0].chat_template_kwargs).toEqual({ enable_thinking: true });
  });
});