import { afterAll, describe, expect, it } from "vitest";
import { createToolRegistry } from "@tinystrap/policy";
import type { HarnessEvent, ToolRegistry } from "@tinystrap/policy";
import { FakeProvider, parseSseRecords, startProxy } from "@tinystrap/proxy";
import type {
  ChatMessage, ChatRequest, Provider, RecordedStream, StreamChunk,
} from "@tinystrap/proxy";

const opened: { url: string; close(): Promise<void> }[] = [];
afterAll(async () => { for (const s of opened) await s.close(); });

function registry(): ToolRegistry {
  const r = createToolRegistry();
  for (const n of ["read", "write", "edit", "bash"]) {
    r.register({ name: n, description: n, inputSchema: {}, capabilities: [], readOnly: false });
  }
  return r;
}

type Delta = StreamChunk["choices"][number]["delta"];

function chunk(delta: Delta, finish: string | null = null): StreamChunk {
  return { choices: [{ index: 0, delta, finish_reason: finish }] };
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

function toolCallStream(name: string, args: string): StreamChunk[] {
  return [
    chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_0", function: { name, arguments: "" } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: args } }] }),
    chunk({}, "tool_calls"),
  ];
}

function messages(count: number): ChatMessage[] {
  return Array.from({ length: count },
    (_, i) => ({ role: "user" as const, content: `message ${i} `.padEnd(40, "x") }));
}

function forwardedArguments(text: string): string[] {
  return parseSseRecords(text).flatMap(
    (c) => c.choices[0]?.delta.tool_calls ?? [])
    .map((d) => d.function?.arguments ?? "").filter((a) => a !== "");
}

async function runProxy(deps: Parameters<typeof startProxy>[0]) {
  const proxy = await startProxy(deps);
  opened.push(proxy);
  return proxy;
}

describe("proxy feature wiring", () => {
  it("repairs a truncated tool call and forwards only the repaired call", async () => {
    const events: HarnessEvent[] = [];
    const proxy = await runProxy({
      provider: new FakeProvider(recorded(toolCallStream("edit", '{"path": "a.txt"'))),
      registry: registry(),
      preflight: () => ({ effect: "allow" }),
      onEvent: (e) => events.push(e),
    });
    const text = await post(proxy.url,
      { model: "m", messages: [{ role: "user", content: "hi" }], stream: true });

    const repair = events.find((e) => e.kind === "tool_call_repaired");
    expect(repair).toBeDefined();
    expect(repair?.tool).toBe("edit");
    expect(repair?.reason).toContain("json:closed");
    // the host sees one complete call, never the unbalanced fragment
    const args = forwardedArguments(text);
    expect(args).toEqual(['{"path": "a.txt"}']);
  });

  it("forwards the raw fragment when tool_call_repair is off", async () => {
    const events: HarnessEvent[] = [];
    const proxy = await runProxy({
      provider: new FakeProvider(recorded(toolCallStream("edit", '{"path": "a.txt"'))),
      registry: registry(),
      preflight: () => ({ effect: "allow" }),
      onEvent: (e) => events.push(e),
      features: { tool_call_repair: false },
    });
    const text = await post(proxy.url,
      { model: "m", messages: [{ role: "user", content: "hi" }], stream: true });

    expect(events.some((e) => e.kind === "tool_call_repaired")).toBe(false);
    expect(forwardedArguments(text)).toEqual(['{"path": "a.txt"']);
  });

  it("truncates history to the budget before the provider sees the request", async () => {
    let seen: ChatRequest | undefined;
    const spy: Provider = {
      stream(req: ChatRequest, signal?: AbortSignal) {
        seen = req;
        return new FakeProvider(recorded([chunk({}, "stop")])).stream(req, signal);
      },
    };
    const proxy = await runProxy({
      provider: spy, registry: registry(), preflight: () => ({ effect: "allow" }),
      budgetTokens: 40,
    });
    await post(proxy.url, { model: "m", messages: messages(6), stream: true });
    expect(seen?.messages.length).toBeLessThan(6);
    expect(seen?.messages.length ?? 0).toBeGreaterThan(0);
  });

  it("leaves history untouched when context_budgeting is off", async () => {
    let seen: ChatRequest | undefined;
    const spy: Provider = {
      stream(req: ChatRequest, signal?: AbortSignal) {
        seen = req;
        return new FakeProvider(recorded([chunk({}, "stop")])).stream(req, signal);
      },
    };
    const proxy = await runProxy({
      provider: spy, registry: registry(), preflight: () => ({ effect: "allow" }),
      budgetTokens: 40, features: { context_budgeting: false },
    });
    await post(proxy.url, { model: "m", messages: messages(6), stream: true });
    expect(seen?.messages.length).toBe(6);
  });

  it("intervenes on a reasoning loop and emits reasoning_intervention", async () => {
    const events: HarnessEvent[] = [];
    const looped = "I will look at the file again to be sure.";
    const proxy = await runProxy({
      provider: new FakeProvider(recorded([
        chunk({ reasoning_content: looped }),
        chunk({ reasoning_content: looped }),
        chunk({ reasoning_content: looped }),
        chunk({}, "stop"),
      ])),
      registry: registry(),
      preflight: () => ({ effect: "allow" }),
      onEvent: (e) => events.push(e),
    });
    const text = await post(proxy.url,
      { model: "m", messages: [{ role: "user", content: "hi" }], stream: true });

    const intervention = events.find((e) => e.kind === "reasoning_intervention");
    expect(intervention).toBeDefined();
    expect(intervention?.reason).toContain("nudge");
    expect(text).toContain("Pause: restate the next concrete step before continuing.");
  });

  it("stays silent on reasoning when reasoning_control is off", async () => {
    const events: HarnessEvent[] = [];
    const looped = "I will look at the file again to be sure.";
    const proxy = await runProxy({
      provider: new FakeProvider(recorded([
        chunk({ reasoning_content: looped }),
        chunk({ reasoning_content: looped }),
        chunk({ reasoning_content: looped }),
        chunk({}, "stop"),
      ])),
      registry: registry(),
      preflight: () => ({ effect: "allow" }),
      onEvent: (e) => events.push(e),
      features: { reasoning_control: false },
    });
    await post(proxy.url,
      { model: "m", messages: [{ role: "user", content: "hi" }], stream: true });
    expect(events.some((e) => e.kind === "reasoning_intervention")).toBe(false);
  });
});
