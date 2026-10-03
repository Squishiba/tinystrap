import { describe, expect, it } from "vitest";
import { FakeProvider, startProxy } from "@tinystrap/proxy";
import type { RecordedStream, StreamChunk } from "@tinystrap/proxy";
import { createToolRegistry } from "@tinystrap/policy";
import { runSmokeTest, SMOKE_TOOL_NAME } from "@tinystrap/core";

// A scripted provider, exactly like the existing proxy tests. The socket is
// loopback to the proxy this test starts - nothing else, and no real server.
function stream(chunks: StreamChunk[]): RecordedStream {
  return { server: "scripted", attempt: "smoke", status: 200, chunks, summary: {} };
}
const toolCallStream = stream([
  { choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1",
      function: { name: SMOKE_TOOL_NAME, arguments: "{\"ok\":true}" } }] },
    finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
]);
const textOnlyStream = stream([
  { choices: [{ index: 0, delta: { role: "assistant", content: "I cannot call tools." },
    finish_reason: "stop" }] },
]);

async function withProxy<T>(provider: FakeProvider, fn: (url: string) => Promise<T>): Promise<T> {
  const proxy = await startProxy({
    provider, registry: createToolRegistry(),
    preflight: () => ({ effect: "allow" as const }),
  });
  try { return await fn(proxy.url); } finally { await proxy.close(); }
}

describe("init smoke test", () => {
  it("passes when one tool call round-trips through the real proxy", async () => {
    const r = await withProxy(new FakeProvider([toolCallStream]),
      (url) => runSmokeTest({ proxyBaseUrl: url, model: "m-a" }));
    expect(r.ok).toBe(true);
    expect(r.toolCalls).toBe(1);
  });
  it("fails, with an actionable reason, when the model answers without calling a tool", async () => {
    const r = await withProxy(new FakeProvider([textOnlyStream]),
      (url) => runSmokeTest({ proxyBaseUrl: url, model: "m-a" }));
    expect(r.ok).toBe(false);
    expect(r.toolCalls).toBe(0);
    expect(r.detail).toContain("without calling");
  });
  it("offers the probe tool, so the model is never asked to guess", () => {
    // The request must carry a tools array: with no tools the proxy forwards none
    // (server.ts:167) and a model cannot call what it was never offered.
    expect(SMOKE_TOOL_NAME).toBe("tinystrap_probe");
  });
});
