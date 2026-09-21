import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createToolRegistry } from "@tinystrap/policy";
import {
  FakeProvider, HARNESS_NOTICE_TOOL, loadRecordedStreams, startProxy,
} from "@tinystrap/proxy";
import type { HarnessEvent, PolicyDecision } from "@tinystrap/policy";

const streams = loadRecordedStreams(join(
  process.cwd(), "docs", "superpowers", "spike-findings", "fixtures", "streams.jsonl"));

function registry() {
  const r = createToolRegistry();
  r.register({ name: "harness_notice", description: "no-op", inputSchema: {}, capabilities: [], readOnly: true });
  for (const n of ["read", "write", "edit", "bash", "get_weather"]) {
    r.register({ name: n, description: n, inputSchema: {}, capabilities: [], readOnly: false });
  }
  return r;
}

async function post(url: string, body: unknown): Promise<string> {
  const res = await fetch(`${url}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.text();
}

describe("proxy server", () => {
  const opened: { url: string; close(): Promise<void> }[] = [];
  afterAll(async () => { for (const s of opened) await s.close(); });

  it("passes through an allowed recorded stream as SSE", async () => {
    const proxy = await startProxy({
      provider: new FakeProvider(streams), registry: registry(),
      preflight: () => ({ effect: "allow" }),
    });
    opened.push(proxy);
    const text = await post(proxy.url,
      { model: "m", messages: [{ role: "user", content: "hi" }], stream: true });
    expect(text).toContain("data:");
    expect(text).toMatch(/\[DONE\]/);
    expect(text).not.toContain(HARNESS_NOTICE_TOOL);
  });

  it("interrupts a denied call: aborts, rewrites to harness_notice, never truncates", async () => {
    const events: HarnessEvent[] = [];
    const deny: PolicyDecision = { effect: "deny", reason: "Target is outside the task workspace.", retryable: true };
    const proxy = await startProxy({
      provider: new FakeProvider(streams), registry: registry(),
      preflight: () => deny, onEvent: (e) => events.push(e),
    });
    opened.push(proxy);
    const text = await post(proxy.url,
      { model: "m", messages: [{ role: "user", content: "hi" }], stream: true });
    expect(text).toContain(HARNESS_NOTICE_TOOL);
    expect(text).toMatch(/\[DONE\]\n\n$/);
    expect(text).not.toContain('"arguments":"{"');   // no bare fragment forwarded
    expect(events.some((e) => e.kind === "tool_interrupted")).toBe(true);
  });

  it("rejects non-stream requests with 400", async () => {
    const proxy = await startProxy({
      provider: new FakeProvider(streams), registry: registry(),
      preflight: () => ({ effect: "allow" }),
    });
    opened.push(proxy);
    const res = await fetch(`${proxy.url}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    expect(res.status).toBe(400);
  });
});
