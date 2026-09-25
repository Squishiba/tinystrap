import type { ChatMessage } from "./types.js";

export const CORRECTION_SENTINEL = "--- harness notice ---";

// Interruptions the host never executed; injected into the NEXT request's history
// so the correction reaches the model without any harness_notice dependency
// (live-check 5 Q1: host behavior for unknown tools is unverified).
export class CorrectionStore {
  private items: string[] = [];
  constructor(private readonly opts: { max?: number } = {}) {}
  add(reason: string): void {
    this.items.push(reason);
    const max = this.opts.max ?? 3;
    if (this.items.length > max) this.items = this.items.slice(-max);
  }
  pending(): string[] { return [...this.items]; }
  clear(): void { this.items = []; }
}

export function injectCorrections(messages: ChatMessage[], corrections: readonly string[]): ChatMessage[] {
  const kept = messages.filter((m) =>
    !(m.role === "system" && typeof m.content === "string" && m.content.startsWith(CORRECTION_SENTINEL)));
  if (corrections.length === 0) return kept;
  const at = kept.length > 0 && kept[0].role === "system" ? 1 : 0;
  const block = `${CORRECTION_SENTINEL}\n${corrections.map((c) => `- ${c}`).join("\n")}\n--- end notice ---`;
  return [...kept.slice(0, at), { role: "system" as const, content: block }, ...kept.slice(at)];
}

// Primitive for gap 4: a correction of a call the host DID execute can be
// written into the replayed tool-result message on the next request.
export function rewriteToolResult(
  messages: ChatMessage[], toolCallId: string, content: string,
): ChatMessage[] {
  return messages.map((m) =>
    m.role === "tool" && m.tool_call_id === toolCallId ? { ...m, content } : m);
}
