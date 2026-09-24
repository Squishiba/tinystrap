import { describe, expect, it } from "vitest";
import { createOpenCodeDialect, createToolRegistry } from "@tinystrap/policy";
import type { PolicyDecision, WireTool } from "@tinystrap/policy";
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

const hostTools: WireTool[] = [
  { type: "function", function: { name: "edit", parameters: {} } },
];

const editStream: StreamChunk[] = [
  { choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1",
    function: { name: "edit",
      arguments: "{\"filePath\":\"/w/task/a.txt\",\"oldString\":\"wrld\",\"newString\":\"hello world\"}" } }] },
    finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
];

async function post(url: string, body: unknown): Promise<Response> {
  return fetch(`${url}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

describe("server dialect wiring", () => {
  it("seeds the registry from the request: an OpenCode edit is not interrupted", async () => {
    const seen: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const provider = new CapturingProvider(editStream);
    const proxy = await startProxy({
      provider, registry: createToolRegistry(),
      preflight: (tool, args): PolicyDecision => { seen.push({ tool, args }); return { effect: "allow" }; },
      dialect: createOpenCodeDialect(), taskId: "t",
    });
    const res = await post(proxy.url, { model: "m", stream: true, tools: hostTools,
      messages: [{ role: "user", content: "go" }] });
    const text = await res.text();
    await proxy.close();
    expect(text).not.toContain("tool_calls\" interrupted");   // no interruption payload
    expect(text).not.toContain("harness_notice");
    expect(seen[0].args).toEqual({ path: "/w/task/a.txt", oldText: "wrld", newText: "hello world" });
  });
  it("without a dialect and without a tools array the old behavior is untouched", async () => {
    // Plan note: the plan's version of this test sent `tools: hostTools` yet expected
    // "edit was never seeded", contradicting the plan's own unconditional seeding
    // wiring (which must also seed identity-dialect hosts like the live-check script).
    // The identity-default regression check is therefore a tools-less request.
    const provider = new CapturingProvider(editStream);
    const proxy = await startProxy({
      provider, registry: createToolRegistry(),
      preflight: () => ({ effect: "allow" }), taskId: "t",
    });
    const res = await post(proxy.url, { model: "m", stream: true,
      messages: [{ role: "user", content: "go" }] });
    const text = await res.text();
    await proxy.close();
    expect(text).toContain("harness_notice");   // unknown_tool interrupt: edit was never seeded
    expect(text).toContain("unknown_tool");
  });
});
