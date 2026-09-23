import { afterAll, describe, expect, it } from "vitest";
import { createToolRegistry } from "@tinystrap/policy";
import type { HarnessEvent, ToolRegistry } from "@tinystrap/policy";
import { FakeProvider, startProxy } from "@tinystrap/proxy";
import type { RecordedStream, StreamChunk } from "@tinystrap/proxy";

const opened: { url: string; close(): Promise<void> }[] = [];
afterAll(async () => { for (const s of opened) await s.close(); });

function registry(): ToolRegistry {
  const r = createToolRegistry();
  for (const n of ["read", "write", "edit", "bash"]) {
    r.register({ name: n, description: n, inputSchema: {}, capabilities: [], readOnly: false });
  }
  return r;
}

function recorded(chunks: StreamChunk[]): RecordedStream[] {
  return [{ server: "fake", attempt: "t", status: 200, chunks, summary: {} }];
}

async function post(url: string, body: unknown): Promise<string> {
  const res = await fetch(`${url}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.text();
}

async function runProxy(deps: Parameters<typeof startProxy>[0]) {
  const proxy = await startProxy(deps);
  opened.push(proxy);
  return proxy;
}

describe("token-usage capture (model_usage)", () => {
  it("emits a model_usage event when a chunk carries usage", async () => {
    const events: HarnessEvent[] = [];
    const proxy = await runProxy({
      provider: new FakeProvider(recorded([
        { choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] },
        {
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 120, completion_tokens: 34 },
        },
      ])),
      registry: registry(),
      preflight: () => ({ effect: "allow" }),
      onEvent: (e) => events.push(e),
    });
    await post(proxy.url,
      { model: "m", messages: [{ role: "user", content: "hi" }], stream: true });

    const usage = events.find((e) => e.kind === "model_usage");
    expect(usage).toBeDefined();
    expect(usage?.usage).toEqual({ prompt: 120, completion: 34 });
  });

  it("emits no model_usage event when no chunk carries usage", async () => {
    const events: HarnessEvent[] = [];
    const proxy = await runProxy({
      provider: new FakeProvider(recorded([
        { choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ])),
      registry: registry(),
      preflight: () => ({ effect: "allow" }),
      onEvent: (e) => events.push(e),
    });
    await post(proxy.url,
      { model: "m", messages: [{ role: "user", content: "hi" }], stream: true });

    expect(events.some((e) => e.kind === "model_usage")).toBe(false);
  });
});