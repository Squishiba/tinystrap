import type { ChatRequest, StreamChunk } from "./types.js";
import { formatSse, SSE_DONE } from "./sse.js";

export const HARNESS_NOTICE_TOOL = "harness_notice";

export function interruptionChunks(_req: ChatRequest, reason: string): StreamChunk[] {
  const id = `notice_${Date.now().toString(36)}`;
  return [
    { choices: [{ index: 0, delta: { role: "assistant", content: null }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id,
      function: { name: HARNESS_NOTICE_TOOL, arguments: JSON.stringify({ reason }) } }] },
      finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ];
}

export function interruptionSse(req: ChatRequest, reason: string): string {
  return interruptionChunks(req, reason).map(formatSse).join("") + SSE_DONE;
}
