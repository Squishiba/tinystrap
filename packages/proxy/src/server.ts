import { createServer, type Server, type ServerResponse } from "node:http";
import { makeEvent } from "@tinystrap/policy";
import type { HarnessEvent, ToolRegistry } from "@tinystrap/policy";
import { formatSse, SSE_DONE } from "./sse.js";
import { StreamGate, type Preflight } from "./gate.js";
import { interruptionSse } from "./rewrite.js";
import { repairToolCalls } from "./repair.js";
import { truncateHistory } from "./budget.js";
import { LoopDetector } from "./loopdetector.js";
import { DEFAULT_FEATURES, type ProxyFeatures } from "./features.js";
import type { ChatRequest, Provider, StreamChunk, ToolCall } from "./types.js";

export type ProxyDeps = {
  provider: Provider;
  registry: ToolRegistry;
  preflight: Preflight;
  onEvent?: (e: HarnessEvent) => void;
  features?: Partial<ProxyFeatures>;
  taskId?: string;
  budgetTokens?: number;
};

export async function startProxy(deps: ProxyDeps, port = 0) {
  const server: Server = createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.endsWith("/v1/chat/completions")) {
      res.writeHead(404).end("not found");
      return;
    }
    const body: Buffer[] = [];
    req.on("data", (d: Buffer) => body.push(d));
    req.on("end", () => void handle(deps, body, res));
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const addr = server.address();
  const url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : port}`;
  return {
    url,
    close: () => new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))),
  };
}

const NUDGE_TEXT = "Pause: restate the next concrete step before continuing.";

function nudgeChunk(): StreamChunk {
  return { choices: [{ index: 0, delta: { role: "assistant", content: NUDGE_TEXT }, finish_reason: null }] };
}

function repairedChunk(calls: ToolCall[]): StreamChunk {
  return {
    choices: [{
      index: 0,
      delta: {
        role: "assistant",
        tool_calls: calls.map((c, i) => ({ index: i, id: c.id, function: c.function })),
      },
      finish_reason: null,
    }],
  };
}

async function handle(
  deps: ProxyDeps, body: Buffer[], res: ServerResponse,
): Promise<void> {
  let chatReq: ChatRequest;
  try { chatReq = JSON.parse(Buffer.concat(body).toString("utf8")) as ChatRequest; }
  catch { res.writeHead(400).end("bad json"); return; }
  if (chatReq.stream !== true) {
    res.writeHead(400).end("this proxy requires stream: true");
    return;
  }
  const feats = { ...DEFAULT_FEATURES, ...deps.features };
  const taskId = deps.taskId ?? "proxy";
  if (feats.context_budgeting && deps.budgetTokens !== undefined) {
    chatReq = { ...chatReq, messages: truncateHistory(chatReq.messages, deps.budgetTokens) };
  }
  deps.onEvent?.(makeEvent(taskId, "tool_stream_started"));
  const gate = new StreamGate({ registry: deps.registry, preflight: deps.preflight });
  const loop = feats.reasoning_control
    ? new LoopDetector({
      taskId, scoreThreshold: 0.7, backstopTokens: 2048, midStreamClose: false,
      onIntervention: (action, signals) => deps.onEvent?.(makeEvent(
        taskId, "reasoning_intervention", { reason: `${action} ${JSON.stringify(signals)}` })),
    })
    : undefined;
  const ac = new AbortController();
  res.writeHead(200, { "content-type": "text/event-stream" });
  // Tool-call fragments are held back until the gate has cleared the call
  // (spec 10.2: the host never sees a truncated fragment if we interrupt).
  const pending: StreamChunk[] = [];
  const flushPending = () => {
    for (const p of pending) res.write(formatSse(p));
    pending.length = 0;
  };
  // Repaired calls replace the buffered fragments: the host never sees the broken ones.
  let repairedOnce = false;
  const flushRepaired = () => {
    if (repairedOnce) { flushPending(); return; }
    repairedOnce = true;
    const results = gate.accumulated().map((c) => repairToolCalls([c], deps.registry));
    const repairs = results.flatMap((r) =>
      r.repairs.map((why) => ({ tool: r.calls[0].function.name, why })));
    if (repairs.length === 0) { flushPending(); return; }
    for (const r of repairs) {
      deps.onEvent?.(makeEvent(taskId, "tool_call_repaired", { tool: r.tool, reason: r.why }));
    }
    pending.length = 0;
    res.write(formatSse(repairedChunk(results.map((r) => r.calls[0]))));
  };
  const flush = feats.tool_call_repair ? flushRepaired : flushPending;
  try {
    for await (const chunk of deps.provider.stream(chatReq, ac.signal)) {
      const action = gate.push(chunk);
      if (action.kind === "interrupt") {
        ac.abort();
        deps.onEvent?.(makeEvent(taskId, "tool_interrupted",
          { tool: action.tool, reason: action.reason }));
        res.write(interruptionSse(chatReq, action.reason));
        res.end();
        return;
      }
      const choice = chunk.choices[0];
      const reasoning = choice?.delta.reasoning_content;
      if (loop && reasoning) {
        const action = loop.push(reasoning);
        if (action === "nudge") res.write(formatSse(nudgeChunk()));
        if (action === "backstop") {
          ac.abort();
          res.write(interruptionSse(chatReq, "reasoning_backstop"));
          res.end();
          return;
        }
      }
      if (choice?.finish_reason) flush();
      if (choice?.delta.tool_calls?.length) pending.push(chunk);
      else res.write(formatSse(chunk));
    }
    flush();
    res.write(SSE_DONE);
    res.end();
  } catch {
    flush();
    res.write(SSE_DONE);
    res.end();
  }
}
