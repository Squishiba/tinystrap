import { createServer, type Server, type ServerResponse } from "node:http";
import { makeEvent } from "@tinystrap/policy";
import type { HarnessEvent, ToolRegistry } from "@tinystrap/policy";
import { formatSse, SSE_DONE } from "./sse.js";
import { StreamGate, type Preflight } from "./gate.js";
import { interruptionSse } from "./rewrite.js";
import type { ChatRequest, Provider, StreamChunk } from "./types.js";

export type ProxyDeps = {
  provider: Provider;
  registry: ToolRegistry;
  preflight: Preflight;
  onEvent?: (e: HarnessEvent) => void;
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
  const taskId = "proxy";
  deps.onEvent?.(makeEvent(taskId, "tool_stream_started"));
  const gate = new StreamGate({ registry: deps.registry, preflight: deps.preflight });
  const ac = new AbortController();
  res.writeHead(200, { "content-type": "text/event-stream" });
  // Tool-call fragments are held back until the gate has cleared the call
  // (spec 10.2: the host never sees a truncated fragment if we interrupt).
  const pending: StreamChunk[] = [];
  const flushPending = () => {
    for (const p of pending) res.write(formatSse(p));
    pending.length = 0;
  };
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
      if (choice?.finish_reason) flushPending();
      if (choice?.delta.tool_calls?.length) pending.push(chunk);
      else res.write(formatSse(chunk));
    }
    flushPending();
    res.write(SSE_DONE);
    res.end();
  } catch {
    flushPending();
    res.write(SSE_DONE);
    res.end();
  }
}
