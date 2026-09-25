import { afterAll, describe, expect, it } from "vitest";
import { createOpenCodeDialect, createToolRegistry } from "@tinystrap/policy";
import type { HarnessEvent, PolicyDecision, ToolRegistry } from "@tinystrap/policy";
import { HARNESS_NOTICE_TOOL, parseSseRecords, startProxy } from "@tinystrap/proxy";
import type { ChatRequest, Provider, StreamChunk } from "@tinystrap/proxy";

// Which interruption kinds retry (design decision, task brief test f):
// only StreamGate denials retry — unknown_tool, host_denied, and argument
// denials / ask decisions from preflight. Those are a refused tool call the
// model can be corrected about in-stream and then continue from. Reasoning
// backstop and guidance stall-stop are harness-side interventions with their
// own escalation semantics (runaway reasoning, repeated stalls) and keep their
// current abort-and-end behaviour; pin_note rewriting is a harness tool the
// host never implements. The retry loop hooks only the gate's interrupt action.

const DENY_REASON = "argument_denied: unclassifiable shell command (fail closed)";
const ARG_DENY: PolicyDecision = { effect: "deny", reason: DENY_REASON, retryable: true };

function registry(): ToolRegistry {
  const r = createToolRegistry();
  for (const n of ["read", "write", "edit", "bash"]) {
    r.register({ name: n, description: n, inputSchema: {}, capabilities: [], readOnly: false });
  }
  return r;
}

type Delta = StreamChunk["choices"][number]["delta"];
const chunk = (delta: Delta, finish: string | null = null): StreamChunk =>
  ({ choices: [{ index: 0, delta, finish_reason: finish }] });

const deniedBash: StreamChunk[] = [
  chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_bash",
    function: { name: "bash", arguments: "" } }] }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: "{\"command\":\"echo hi\"}" } }] }),
  chunk({}, "tool_calls"),
];

const validRead: StreamChunk[] = [
  chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_read",
    function: { name: "read", arguments: "" } }] }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: "{\"path\":\"a.txt\"}" } }] }),
  chunk({}, "tool_calls"),
];

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

describe("interruption_retry (proxy-side bounded retry of denied tool calls)", () => {
  it("(a) retries a denied call in-stream: client sees only the retried call", async () => {
    const events: HarnessEvent[] = [];
    const provider = new CapturingProvider([deniedBash, validRead]);
    const proxy = await runProxy({
      provider, registry: registry(),
      preflight: (tool) => tool === "bash" ? ARG_DENY : { effect: "allow" },
      dialect: createOpenCodeDialect(), taskId: "t", onEvent: (e) => events.push(e),
    });
    const text = await post(proxy.url);

    // The client SSE carries ONLY the second (valid) call as a tool call: no
    // denied call, no harness_notice, no content correction.
    const records = parseSseRecords(text);
    const names = records.flatMap((c) => c.choices[0]?.delta.tool_calls ?? [])
      .map((d) => d.function?.name).filter((n) => n !== undefined);
    expect(names).toEqual(["read"]);
    expect(text).not.toContain("call_bash");
    expect(text).not.toContain(HARNESS_NOTICE_TOOL);
    expect(text).not.toContain("Harness:");

    // Exactly one finish chunk and one [DONE]; well-formed stream.
    const finishes = records.filter((c) => c.choices[0]?.finish_reason != null);
    expect(finishes.length).toBe(1);
    expect(finishes[0]?.choices[0]?.finish_reason).toBe("tool_calls");
    expect(text.split("data: [DONE]").length - 1).toBe(1);
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);

    // The second upstream request carries the attempted tool call plus the
    // role-"tool" correction message under one synthetic id.
    expect(provider.seen.length).toBe(2);
    const retry = provider.seen[1];
    const assistant = retry.messages.find((m) =>
      m.role === "assistant" && (m.tool_calls?.length ?? 0) > 0);
    expect(assistant).toBeDefined();
    const callId = assistant!.tool_calls![0].id;
    expect(callId).toMatch(/^call_retry_1_/);
    expect(assistant!.tool_calls![0].function.name).toBe("bash");
    expect(assistant!.tool_calls![0].function.arguments).toBe('{"command":"echo hi"}');
    const toolMsg = retry.messages.find((m) => m.role === "tool" && m.tool_call_id === callId);
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content).toBe(`Harness: ${DENY_REASON}`);
    const userIdx = retry.messages.findIndex((m) => m.role === "user" && m.content === "go");
    const asstIdx = retry.messages.indexOf(assistant!);
    expect(userIdx).toBeGreaterThanOrEqual(0);
    expect(asstIdx).toBeGreaterThan(userIdx);

    // An audit event records the retry.
    const retryEvent = events.find((e) =>
      e.kind === "tool_interrupted" && e.reason === `retrying 1/3: ${DENY_REASON}`);
    expect(retryEvent).toBeDefined();
    expect(retryEvent?.tool).toBe("bash");
    expect(events.some((e) => e.kind === "tool_interrupted" && e.reason === DENY_REASON)).toBe(false);
  });

  it("(b) falls back to the content interruption after maxInterruptRetries denied calls", async () => {
    const events: HarnessEvent[] = [];
    const provider = new CapturingProvider([deniedBash]);
    const proxy = await runProxy({
      provider, registry: registry(),
      preflight: (tool) => tool === "bash" ? ARG_DENY : { effect: "allow" },
      dialect: createOpenCodeDialect(), taskId: "t", onEvent: (e) => events.push(e),
      maxInterruptRetries: 2,
    });
    const text = await post(proxy.url);

    // original + 2 bounded retries, then the fallback interruption.
    expect(provider.seen.length).toBe(3);
    const records = parseSseRecords(text);
    const names = records.flatMap((c) => c.choices[0]?.delta.tool_calls ?? [])
      .map((d) => d.function?.name);
    expect(names).toEqual([]); // no tool call ever reaches the client
    const finishes = records.filter((c) => c.choices[0]?.finish_reason != null);
    expect(finishes.length).toBe(1);
    expect(finishes[0]?.choices[0]?.finish_reason).toBe("stop");
    expect(text).toContain(`Harness: ${DENY_REASON}`);
    expect(text).not.toContain(HARNESS_NOTICE_TOOL);
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);

    const retries = events.filter((e) =>
      e.kind === "tool_interrupted" && e.reason?.startsWith("retrying"));
    expect(retries.map((e) => e.reason)).toEqual([
      `retrying 1/2: ${DENY_REASON}`,
      `retrying 2/2: ${DENY_REASON}`,
    ]);
    const fallback = events.filter((e) =>
      e.kind === "tool_interrupted" && !e.reason?.startsWith("retrying"));
    expect(fallback.map((e) => e.reason)).toEqual([DENY_REASON]);
  });

  it("(c) falls back to the content interruption when a retry request fails", async () => {
    const events: HarnessEvent[] = [];
    let calls = 0;
    const flaky: Provider = {
      async *stream(_req: ChatRequest): AsyncIterable<StreamChunk> {
        calls++;
        if (calls === 1) { yield* deniedBash; return; }
        throw new Error("upstream unavailable");
      },
    };
    const proxy = await runProxy({
      provider: flaky, registry: registry(),
      preflight: (tool) => tool === "bash" ? ARG_DENY : { effect: "allow" },
      dialect: createOpenCodeDialect(), taskId: "t", onEvent: (e) => events.push(e),
    });
    const text = await post(proxy.url);

    expect(calls).toBe(2); // original + one retry whose request failed
    const records = parseSseRecords(text);
    expect(records.flatMap((c) => c.choices[0]?.delta.tool_calls ?? []).length).toBe(0);
    const finishes = records.filter((c) => c.choices[0]?.finish_reason != null);
    expect(finishes.length).toBe(1);
    expect(finishes[0]?.choices[0]?.finish_reason).toBe("stop");
    expect(text).toContain(`Harness: ${DENY_REASON}`);
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(events.some((e) =>
      e.kind === "tool_interrupted" && e.reason === `retrying 1/3: ${DENY_REASON}`)).toBe(true);
    expect(events.some((e) =>
      e.kind === "tool_interrupted" && e.reason === DENY_REASON)).toBe(true);
  });

  it("(d) feature off: identical to main — immediate interruption, one upstream request", async () => {
    const events: HarnessEvent[] = [];
    const provider = new CapturingProvider([deniedBash, validRead]);
    const proxy = await runProxy({
      provider, registry: registry(),
      preflight: (tool) => tool === "bash" ? ARG_DENY : { effect: "allow" },
      taskId: "t", onEvent: (e) => events.push(e),
      features: { interruption_retry: false },
    });
    const text = await post(proxy.url);

    expect(provider.seen.length).toBe(1); // no retry request
    expect(text).toContain(HARNESS_NOTICE_TOOL);
    expect(text).toContain(DENY_REASON);
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(events.some((e) => e.reason?.startsWith("retrying"))).toBe(false);
    expect(events.some((e) =>
      e.kind === "tool_interrupted" && e.reason === DENY_REASON)).toBe(true);
  });

  it("(e) keeps already-streamed assistant text intact across the retry", async () => {
    const textThenDenied: StreamChunk[] = [
      chunk({ role: "assistant", content: "Let me check that." }),
      chunk({ content: " Running shell now." }),
      chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_bash",
        function: { name: "bash", arguments: "" } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: "{\"command\":\"echo hi\"}" } }] }),
      chunk({}, "tool_calls"),
    ];
    const continuation: StreamChunk[] = [
      chunk({ role: "assistant", content: "Continuing after the denial." }),
      ...validRead,
    ];
    const provider = new CapturingProvider([textThenDenied, continuation]);
    const proxy = await runProxy({
      provider, registry: registry(),
      preflight: (tool) => tool === "bash" ? ARG_DENY : { effect: "allow" },
      dialect: createOpenCodeDialect(), taskId: "t",
    });
    const text = await post(proxy.url);

    // First-stream text is present exactly once; the retried stream continues it.
    const joined = parseSseRecords(text)
      .map((c) => c.choices[0]?.delta.content ?? "").join("");
    expect(joined).toBe("Let me check that. Running shell now.Continuing after the denial.");
    expect(joined.split("Let me check that. Running shell now.").length - 1).toBe(1);
    expect(text).toContain("Continuing after the denial.");
    const names = parseSseRecords(text)
      .flatMap((c) => c.choices[0]?.delta.tool_calls ?? [])
      .map((d) => d.function?.name).filter((n) => n !== undefined);
    expect(names).toEqual(["read"]);
  });

  it("(f) stall-stop and reasoning-backstop interruptions are NOT retried", async () => {
    // Stall-stop (guidance escalation): identical repeated calls -> nudge,
    // replan, stop; the stream aborts with one upstream call and no retry.
    const stallEvents: HarnessEvent[] = [];
    const one: StreamChunk = { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c",
      function: { name: "read", arguments: '{"path":"a.ts"}' } }] }, finish_reason: null }] };
    const done: StreamChunk = { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] };
    const stallChunks = [one, done, one, done, one, done];
    let stallStreams = 0;
    const stallProvider: Provider = {
      async *stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamChunk> {
        stallStreams++;
        for (const c of stallChunks) { if (signal?.aborted) return; yield c; }
      },
    };
    const stallProxy = await runProxy({
      provider: stallProvider,
      registry: (() => { const r = createToolRegistry();
        r.register({ name: "read", description: "read", inputSchema: {}, capabilities: [], readOnly: true });
        return r; })(),
      preflight: () => ({ effect: "allow" }),
      onEvent: (e) => stallEvents.push(e),
    });
    const stallText = await post(stallProxy.url);
    expect(stallStreams).toBe(1);
    expect(stallEvents.filter((e) => e.kind === "stall_escalated").map((e) => e.reason))
      .toEqual(["nudge:1", "replan:2", "stop:3"]);
    expect(stallText).toContain(HARNESS_NOTICE_TOOL);
    expect(stallText.endsWith("data: [DONE]\n\n")).toBe(true);

    // Reasoning backstop: a runaway reasoning stream hits the backstop and is
    // aborted — one upstream call, no retry, harness_notice interruption.
    const backstopEvents: HarnessEvent[] = [];
    const delta = "going over the same ground again and again in circles here.";
    const chunks: StreamChunk[] = Array.from({ length: 300 }, () => chunk({ reasoning_content: delta }));
    chunks.push(chunk({}, "stop"));
    let backstopStreams = 0;
    const backstopProvider: Provider = {
      async *stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamChunk> {
        backstopStreams++;
        for (const c of chunks) { if (signal?.aborted) return; yield c; }
      },
    };
    const backstopProxy = await runProxy({
      provider: backstopProvider, registry: registry(),
      preflight: () => ({ effect: "allow" }),
      onEvent: (e) => backstopEvents.push(e),
    });
    const backstopText = await post(backstopProxy.url);
    expect(backstopStreams).toBe(1);
    const interventions = backstopEvents.filter((e) => e.kind === "reasoning_intervention");
    expect(interventions.length).toBeGreaterThan(0);
    expect(interventions.at(-1)?.reason).toContain("backstop");
    const out = parseSseRecords(backstopText);
    expect(out.at(-1)?.choices[0]?.finish_reason).toBe("tool_calls");
    expect(backstopText.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(backstopEvents.some((e) => e.reason?.startsWith("retrying"))).toBe(false);
  });
});