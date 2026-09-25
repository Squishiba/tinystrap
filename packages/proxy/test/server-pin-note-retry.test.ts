import { afterAll, describe, expect, it } from "vitest";
import { createToolRegistry } from "@tinystrap/policy";
import type { HarnessEvent, ToolRegistry } from "@tinystrap/policy";
import { HARNESS_NOTICE_TOOL, parseSseRecords, startProxy } from "@tinystrap/proxy";
import type { ChatRequest, Provider, StreamChunk } from "@tinystrap/proxy";

// pin_note is a harness-owned tool the host never implements, so an all-pin_note
// turn must not surface to the host as a synthetic final answer (that ends the
// agent run). Instead the proxy discards the buffered call and re-calls the
// provider in the same client SSE stream with the pin call plus a role-"tool"
// result message — the same in-stream retry mechanism as interruption_retry.
// These tests mirror server-interruption-retry.test.ts; FakeProvider only.

const PIN_ARGS = '{"key":"plan","note":"ship v1"}';

type Delta = StreamChunk["choices"][number]["delta"];
const chunk = (delta: Delta, finish: string | null = null): StreamChunk =>
  ({ choices: [{ index: 0, delta, finish_reason: finish }] });

const pinCall: StreamChunk[] = [
  chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_pin",
    function: { name: "pin_note", arguments: PIN_ARGS } }] }),
  chunk({}, "tool_calls"),
];

const textAnswer: StreamChunk[] = [
  chunk({ role: "assistant", content: "Pinned. Proceeding." }),
  chunk({}, "stop"),
];

const readCall: StreamChunk[] = [
  chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_read",
    function: { name: "read", arguments: "" } }] }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: '{"path":"a.txt"}' } }] }),
  chunk({}, "tool_calls"),
];

// Mixed pin_note + real tool call (v1 documented limitation: applied + logged,
// but the raw stream is forwarded unchanged — see the flushStream comment).
const mixedCall: StreamChunk[] = [
  chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_pin",
    function: { name: "pin_note", arguments: PIN_ARGS } }] }),
  chunk({ role: "assistant", tool_calls: [{ index: 1, id: "call_read",
    function: { name: "read", arguments: "" } }] }),
  chunk({ tool_calls: [{ index: 1, function: { arguments: '{"path":"a.txt"}' } }] }),
  chunk({}, "tool_calls"),
];

function registry(): ToolRegistry {
  const r = createToolRegistry();
  for (const n of ["read", "write", "edit", "bash"]) {
    r.register({ name: n, description: n, inputSchema: {}, capabilities: [], readOnly: false });
  }
  return r;
}

class CapturingProvider implements Provider {
  seen: ChatRequest[] = [];
  constructor(private readonly streams: StreamChunk[][]) {}
  async *stream(req: ChatRequest): AsyncIterable<StreamChunk> {
    this.seen.push(req);
    for (const c of this.streams[Math.min(this.seen.length - 1, this.streams.length - 1)]) yield c;
  }
}

async function post(url: string): Promise<string> {
  const res = await fetch(`${url}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m", stream: true,
      messages: [{ role: "user", content: "go" }] }),
  });
  return res.text();
}

const opened: { url: string; close(): Promise<void> }[] = [];
afterAll(async () => { for (const s of opened) await s.close(); });

async function runProxy(deps: Parameters<typeof startProxy>[0]) {
  const proxy = await startProxy(deps);
  opened.push(proxy);
  return proxy;
}

function toolCallNames(text: string): (string | undefined)[] {
  return parseSseRecords(text)
    .flatMap((c) => c.choices[0]?.delta.tool_calls ?? [])
    .map((d) => d.function?.name)
    .filter((n) => n !== undefined);
}

describe("pin_note in-stream retry (all-pin_note turns keep the run alive)", () => {
  it("(a) pin_note then a real answer: client sees only the second response, one finish, one [DONE]", async () => {
    const events: HarnessEvent[] = [];
    const provider = new CapturingProvider([pinCall, textAnswer, textAnswer]);
    const proxy = await runProxy({
      provider, registry: registry(), preflight: () => ({ effect: "allow" }),
      taskId: "t", onEvent: (e) => events.push(e),
    });
    const text = await post(proxy.url);

    // The client SSE carries only the second (real) response: no pin_note call,
    // no synthetic harness_notice turn, no extra finish.
    const records = parseSseRecords(text);
    expect(records.flatMap((c) => c.choices[0]?.delta.tool_calls ?? []).length).toBe(0);
    expect(text).not.toContain("call_pin");
    expect(text).not.toContain(HARNESS_NOTICE_TOOL);
    const joined = records.map((c) => c.choices[0]?.delta.content ?? "").join("");
    expect(joined).toBe("Pinned. Proceeding.");
    const finishes = records.filter((c) => c.choices[0]?.finish_reason != null);
    expect(finishes.length).toBe(1);
    expect(finishes[0]?.choices[0]?.finish_reason).toBe("stop");
    expect(text.split("data: [DONE]").length - 1).toBe(1);
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);

    // The second upstream request carries the attempted pin call plus the
    // role-"tool" result message under one synthetic id.
    expect(provider.seen.length).toBe(2);
    const retry = provider.seen[1];
    const assistant = retry.messages.find((m) =>
      m.role === "assistant" && (m.tool_calls?.length ?? 0) > 0);
    expect(assistant).toBeDefined();
    const callId = assistant!.tool_calls![0].id;
    expect(callId).toMatch(/^call_pin_1_/);
    expect(assistant!.tool_calls![0].function.name).toBe("pin_note");
    expect(assistant!.tool_calls![0].function.arguments).toBe(PIN_ARGS);
    const toolMsg = retry.messages.find((m) => m.role === "tool" && m.tool_call_id === callId);
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content).toBe("pin_note: pinned plan");

    // The note is stored (audit event emitted)…
    expect(events.some((e) => e.kind === "tool_executed" && e.tool === "pin_note")).toBe(true);
    // …and re-injected into later requests exactly as today.
    await post(proxy.url);
    const later = provider.seen.at(-1)!;
    const pinned = later.messages.filter((m) =>
      m.role === "system" && m.content?.startsWith("--- pinned notes"));
    expect(pinned.length).toBe(1);
    expect(pinned[0]!.content).toContain("plan: ship v1");
  });

  it("(a2) pin_note then a valid tool call: the tool call reaches the host once", async () => {
    const provider = new CapturingProvider([pinCall, readCall]);
    const proxy = await runProxy({
      provider, registry: registry(), preflight: () => ({ effect: "allow" }),
    });
    const text = await post(proxy.url);

    expect(provider.seen.length).toBe(2); // original + one in-stream retry
    const names = toolCallNames(text);
    expect(names).toEqual(["read"]);
    expect(text).not.toContain(HARNESS_NOTICE_TOOL);
    const finishes = parseSseRecords(text).filter((c) => c.choices[0]?.finish_reason != null);
    expect(finishes.length).toBe(1);
    expect(finishes[0]?.choices[0]?.finish_reason).toBe("tool_calls");
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
  });

  it("(b) pin_note turns beyond the bound fall back to the synthetic turn, well-formed SSE", async () => {
    const events: HarnessEvent[] = [];
    const provider = new CapturingProvider([pinCall]); // keeps re-pinning forever
    const proxy = await runProxy({
      provider, registry: registry(), preflight: () => ({ effect: "allow" }),
      taskId: "t", onEvent: (e) => events.push(e), maxPinNoteTurns: 2,
    });
    const text = await post(proxy.url);

    // original + 2 bounded retries, then the synthetic fallback turn.
    expect(provider.seen.length).toBe(3);
    const records = parseSseRecords(text);
    expect(toolCallNames(text)).toEqual([HARNESS_NOTICE_TOOL]);
    const finishes = records.filter((c) => c.choices[0]?.finish_reason != null);
    expect(finishes.length).toBe(1);
    expect(finishes[0]?.choices[0]?.finish_reason).toBe("tool_calls");
    expect(text).toContain("pin_note: pinned plan");
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);

    // Each attempted pin turn applied the (idempotent) note and was audited.
    const execs = events.filter((e) => e.kind === "tool_executed" && e.tool === "pin_note");
    expect(execs.length).toBe(3);
  });

  it("(c) retry request fails: fall back to the synthetic turn, well-formed SSE", async () => {
    const events: HarnessEvent[] = [];
    let calls = 0;
    const flaky: Provider = {
      async *stream(_req: ChatRequest): AsyncIterable<StreamChunk> {
        calls++;
        if (calls === 1) { yield* pinCall; return; }
        throw new Error("upstream unavailable");
      },
    };
    const proxy = await runProxy({
      provider: flaky, registry: registry(), preflight: () => ({ effect: "allow" }),
      taskId: "t", onEvent: (e) => events.push(e),
    });
    const text = await post(proxy.url);

    expect(calls).toBe(2); // original + one retry whose request failed
    const records = parseSseRecords(text);
    expect(toolCallNames(text)).toEqual([HARNESS_NOTICE_TOOL]);
    const finishes = records.filter((c) => c.choices[0]?.finish_reason != null);
    expect(finishes.length).toBe(1);
    expect(finishes[0]?.choices[0]?.finish_reason).toBe("tool_calls");
    expect(text).toContain("pin_note: pinned plan");
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(events.some((e) => e.kind === "tool_executed" && e.tool === "pin_note")).toBe(true);
  });

  it("(d) flag off: pinned_notes disabled never applies the pin retry, falls back to interruption handling", async () => {
    const events: HarnessEvent[] = [];
    const provider = new CapturingProvider([pinCall, textAnswer]);
    const proxy = await runProxy({
      provider, registry: registry(), preflight: () => ({ effect: "allow" }),
      taskId: "t", onEvent: (e) => events.push(e), features: { pinned_notes: false },
    });
    const text = await post(proxy.url);

    // With the flag off, pin_note is not registered, so the gate trips
    // unknown_tool on it and main's interruption_retry kicks in (corrective
    // "Harness:" tool message) — the pin_note tool-message retry must NOT fire.
    expect(provider.seen.length).toBe(2);
    const toolMsg = provider.seen.at(-1)!.messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content.startsWith("Harness: unknown_tool: `pin_note`")).toBe(true);
    expect(toolMsg!.content.startsWith("pin_note:")).toBe(false);
    expect(events.some((e) => e.kind === "tool_executed" && e.tool === "pin_note")).toBe(false);
    expect(events.some((e) => e.kind === "tool_interrupted" && e.tool === "pin_note")).toBe(true);
    // The client sees the corrected second response only: one finish, one [DONE].
    const records = parseSseRecords(text);
    expect(records.flatMap((c) => c.choices[0]?.delta.tool_calls ?? []).length).toBe(0);
    const finishes = records.filter((c) => c.choices[0]?.finish_reason != null);
    expect(finishes.length).toBe(1);
    expect(finishes[0]?.choices[0]?.finish_reason).toBe("stop");
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
  });

  it("(e) mixed pin_note + other-tool calls keep the documented v1 raw forwarding", async () => {
    const events: HarnessEvent[] = [];
    const provider = new CapturingProvider([mixedCall]);
    const proxy = await runProxy({
      provider, registry: registry(), preflight: () => ({ effect: "allow" }),
      taskId: "t", onEvent: (e) => events.push(e),
    });
    const text = await post(proxy.url);

    // No retry: both calls reach the host raw, exactly as on main. (Re-running a
    // mixed turn through the tool-message mechanism would discard the host's
    // real tool call, so it is left alone until the supervisor plan lands
    // tool-result plumbing for pin_note with real tools.)
    expect(provider.seen.length).toBe(1);
    expect(toolCallNames(text)).toEqual(["pin_note", "read"]);
    const finishes = parseSseRecords(text).filter((c) => c.choices[0]?.finish_reason != null);
    expect(finishes.length).toBe(1);
    expect(finishes[0]?.choices[0]?.finish_reason).toBe("tool_calls");
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
    // The note was still applied and audited.
    expect(events.some((e) => e.kind === "tool_executed" && e.tool === "pin_note")).toBe(true);
  });
});