import { createServer, type Server, type ServerResponse } from "node:http";
import { makeEvent, effectSignature, effectsForHarnessTool, PIN_NOTE_TOOL, PIN_NOTE_TOOL_NAME } from "@tinystrap/policy";
import type { HarnessEvent, ToolRegistry } from "@tinystrap/policy";
import type { Phase } from "@tinystrap/policy";
import { formatSse, SSE_DONE } from "./sse.js";
import { StreamGate, type Preflight } from "./gate.js";
import { interruptionChunks, interruptionSse } from "./rewrite.js";
import { repairToolCalls } from "./repair.js";
import { truncateHistory } from "./budget.js";
import { LoopDetector } from "./loopdetector.js";
import { NoteStore } from "./notes.js";
import { applyPinNote, withPinnedNotes } from "./notetool.js";
import { DEFAULT_FEATURES, type ProxyFeatures } from "./features.js";
import { GuidanceState, parsePlanItems, toolCards, injectGuidance, STALL_NUDGE, STALL_REPLAN } from "./guidance.js";
import { thinkingForRequest, selectProfile } from "./profiles.js";
import type { ChatRequest, Provider, StreamChunk, ToolCall } from "./types.js";

export type ProxyDeps = {
  provider: Provider;
  registry: ToolRegistry;
  preflight: Preflight;
  onEvent?: (e: HarnessEvent) => void;
  features?: Partial<ProxyFeatures>;
  taskId?: string;
  budgetTokens?: number;
  serverCaps?: Record<string, boolean> | null;
  phase?: () => Phase;
};

export async function startProxy(deps: ProxyDeps, port = 0) {
  // One NoteStore per proxy instance (one proxy per task — same lifetime
  // assumption as bench Task 3's taskId); pinned state is not persisted
  // across startProxy calls / task resume (out of scope, spec 12.7).
  const notes = new NoteStore();
  const server: Server = createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.endsWith("/v1/chat/completions")) {
      res.writeHead(404).end("not found");
      return;
    }
    const body: Buffer[] = [];
    req.on("data", (d: Buffer) => body.push(d));
    req.on("end", () => void handle(deps, body, res, notes));
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

function jsonDocuments(s: string): string[] {
  const docs: string[] = [];
  let depth = 0; let inStr = false; let esc = false; let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") depth++;
    if (ch === "}") { depth--; if (depth === 0) { docs.push(s.slice(start, i + 1)); start = i + 1; } }
  }
  return docs.length === 0 ? [s] : docs;
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
  deps: ProxyDeps, body: Buffer[], res: ServerResponse, notes: NoteStore,
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
  if (feats.reasoning_control) {
    const kw = thinkingForRequest(chatReq.model, deps.serverCaps ?? null, deps.phase?.() ?? "planning");
    if (kw.chat_template_kwargs) {
      chatReq = { ...chatReq,
        chat_template_kwargs: { ...kw.chat_template_kwargs, ...(chatReq.chat_template_kwargs ?? {}) } };
    }
  }
  if (feats.context_budgeting && deps.budgetTokens !== undefined) {
    chatReq = { ...chatReq, messages: truncateHistory(chatReq.messages, deps.budgetTokens) };
  }
  const guidance = new GuidanceState({
    taskId,
    toolCardLimit: (selectProfile(chatReq.model) as { toolCardLimit?: number }).toolCardLimit ?? 3,
  });
  if (feats.guidance) {
    const blocks: string[] = [];
    if (!guidance.hasPlan()) blocks.push(guidance.requirePlan());
    const cards = toolCards(deps.registry.all(), guidance.toolCardLimit);
    if (cards.length > 0) blocks.push(`tool cards:\n${cards.join("\n")}`);
    chatReq = { ...chatReq, messages: injectGuidance(chatReq.messages, blocks) };
  }
  // pin_note is a harness tool the host never implements: register it if the
  // caller's registry does not already carry it, and re-inject the pinned
  // block before the provider sees the request (spec 12.7).
  if (feats.pinned_notes) {
    if (!deps.registry.lookup(PIN_NOTE_TOOL_NAME)) deps.registry.register(PIN_NOTE_TOOL);
    chatReq = { ...chatReq, messages: withPinnedNotes(chatReq.messages, notes.renderPinned()) };
  }
  deps.onEvent?.(makeEvent(taskId, "tool_stream_started"));
  const gate = new StreamGate({ registry: deps.registry, preflight: deps.preflight });
  const loop = feats.reasoning_control
    ? new LoopDetector({
      taskId, scoreThreshold: 0.7, backstopTokens: 2048, midStreamClose: false,
      onIntervention: (action, signals, detail) => deps.onEvent?.(makeEvent(
        taskId, "reasoning_intervention", { reason: `${detail ?? action} ${JSON.stringify(signals)}` })),
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
  const baseFlush = feats.tool_call_repair ? flushRepaired : flushPending;
  // At each flush point, feed the completed calls to the guidance state; a stall
  // escalates nudge -> replan -> stop (spec 12.5).
  let stopRequested = false;
  // The gate concatenates argument fragments per call slot, so a completed
  // call's arguments may hold several back-to-back JSON documents. Split them
  // so each completed call is recorded exactly as the model emitted it.
  const completedCalls = (): ToolCall[] => {
    const out: ToolCall[] = [];
    for (const c of gate.accumulated()) {
      for (const doc of jsonDocuments(c.function.arguments)) {
        out.push({ id: c.id, type: "function", function: { name: c.function.name, arguments: doc } });
      }
    }
    return out;
  };
  const flush = () => {
    baseFlush();
    if (!feats.guidance) return;
    if (guidance.recordCalls(completedCalls())) {
      const level = guidance.escalate();
      deps.onEvent?.(makeEvent(taskId, "stall_escalated", { reason: `${level}:${guidance.stallCount()}` }));
      if (level === "stop") {
        ac.abort();
        stopRequested = true;
        res.write(interruptionSse(chatReq, "guidance: stall stop"));
        res.end();
        return;
      }
      const nudge = level === "nudge" ? STALL_NUDGE : STALL_REPLAN;
      res.write(formatSse({ choices: [{ index: 0, delta: { content: nudge }, finish_reason: null }] }));
    }
  };
  let assistantText = "";
  // Intercept pin_note calls at the flush point: apply them to the note store,
  // emit the audit event, and — when every accumulated call is pin_note —
  // replace the raw stream with a well-formed synthetic turn the host can
  // interpret (it does not implement pin_note). Known v1 limitation (documented):
  // mixed pin_note + other-tool calls apply and log the notes but forward the
  // raw stream unchanged; full tool-result plumbing is a later supervisor-plan
  // item.
  const flushStream = (): boolean => {
    if (!feats.pinned_notes) { flush(); return false; }
    const calls = gate.accumulated();
    const pinCalls = calls.filter((c) => c.function.name === PIN_NOTE_TOOL_NAME);
    let lastMessage = "";
    for (const call of pinCalls) {
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(call.function.arguments) as Record<string, unknown>; }
      catch { parsed = {}; }
      const out = applyPinNote(notes, parsed);
      lastMessage = out.message;
      deps.onEvent?.(makeEvent(taskId, "tool_executed", {
        tool: PIN_NOTE_TOOL_NAME,
        reason: out.message,
        effectSignature: effectSignature(effectsForHarnessTool(PIN_NOTE_TOOL_NAME)),
      }));
    }
    if (pinCalls.length > 0 && pinCalls.length === calls.length) {
      pending.length = 0;
      res.write(interruptionChunks(chatReq, `pin_note: ${lastMessage}`)
        .map(formatSse).join("") + SSE_DONE);
      res.end();
      return true;
    }
    flush();
    return false;
  };
  try {
    for await (const chunk of deps.provider.stream(chatReq, ac.signal)) {
      // Token-usage capture (spec 15 metrics): OpenAI-compatible streams may
      // report `usage` on the final chunk (llama.cpp sends it when the client
      // requests `stream_options: { include_usage: true }` — whether the proxy
      // must inject that flag for real runs is UNVERIFIED). Record whatever
      // the stream carries; this is baseline instrumentation, intentionally
      // not gated behind any ablation feature flag.
      if (chunk.usage) {
        deps.onEvent?.(makeEvent(taskId, "model_usage", {
          usage: {
            prompt: chunk.usage.prompt_tokens ?? 0,
            completion: chunk.usage.completion_tokens ?? 0,
          },
        }));
      }
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
      assistantText += choice?.delta.content ?? "";
      if (choice?.finish_reason) { if (flushStream()) return; if (stopRequested) return; }
      if (choice?.delta.tool_calls?.length) pending.push(chunk);
      else res.write(formatSse(chunk));
    }
    const items = parsePlanItems(assistantText);
    if (items.length > 0 && !guidance.hasPlan()) {
      guidance.submitPlan(items);
      deps.onEvent?.(makeEvent(taskId, "guidance_updated", { reason: `plan:${items.length}` }));
    }
    if (flushStream()) return;
    if (stopRequested) return;
    res.write(SSE_DONE);
    res.end();
  } catch {
    if (flushStream()) return;
    if (stopRequested) return;
    res.write(SSE_DONE);
    res.end();
  }
}
