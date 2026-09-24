import { describe, expect, it } from "vitest";
import { createOpenCodeDialect, createToolRegistry } from "@tinystrap/policy";
import type { WireTool } from "@tinystrap/policy";
import { startProxy } from "@tinystrap/proxy";
import type { ChatRequest, Provider, StreamChunk } from "@tinystrap/proxy";

class CapturingProvider implements Provider {
  seen: ChatRequest[] = [];
  constructor(private readonly chunks: StreamChunk[]) {}
  async *stream(req: ChatRequest): AsyncIterable<StreamChunk> {
    this.seen.push(req);
    for (const c of this.chunks) yield c;
  }
}

const textStream: StreamChunk[] = [
  { choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
];

const hostTools: WireTool[] = ["read", "edit", "webfetch", "task", "skill"].map((name) => ({
  type: "function" as const, function: { name, description: name, parameters: {} },
}));

async function post(url: string, body: unknown): Promise<Response> {
  return fetch(`${url}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

describe("forwarded tools array", () => {
  it("drops disposition-denied tools and adds pin_note to what the model sees", async () => {
    const provider = new CapturingProvider(textStream);
    const proxy = await startProxy({ provider, registry: createToolRegistry(),
      preflight: () => ({ effect: "allow" }), dialect: createOpenCodeDialect(),
      taskId: "t", features: { guidance: false } });
    await (await post(proxy.url, { model: "m", stream: true, tools: hostTools,
      messages: [{ role: "user", content: "go" }] })).text();
    await proxy.close();
    const names = provider.seen[0].tools!.map((t) => t.function.name);
    expect(names.sort()).toEqual(["edit", "pin_note", "read"]);
  });
  it("honors the phase allowlist", async () => {
    const provider = new CapturingProvider(textStream);
    const proxy = await startProxy({ provider, registry: createToolRegistry(),
      preflight: () => ({ effect: "allow" }), dialect: createOpenCodeDialect(),
      taskId: "t", features: { guidance: false, pinned_notes: false },
      phaseAllowlists: { planning: ["read"] } });
    await (await post(proxy.url, { model: "m", stream: true, tools: hostTools,
      messages: [{ role: "user", content: "go" }] })).text();
    await proxy.close();
    const names = provider.seen[0].tools!.map((t) => t.function.name);
    expect(names).toEqual(["read"]);
  });
  it("a request without a tools array stays without one", async () => {
    const provider = new CapturingProvider(textStream);
    const proxy = await startProxy({ provider, registry: createToolRegistry(),
      preflight: () => ({ effect: "allow" }), taskId: "t", features: { guidance: false } });
    await (await post(proxy.url, { model: "m", stream: true,
      messages: [{ role: "user", content: "go" }] })).text();
    await proxy.close();
    expect(provider.seen[0].tools).toBeUndefined();
  });
});
