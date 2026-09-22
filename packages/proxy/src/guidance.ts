import type { ToolDefinition } from "@tinystrap/policy";
import type { ChatMessage } from "./types.js";

export const GUIDANCE_SENTINEL = "--- harness guidance ---";

export function parsePlanItems(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*[-*]\s+\[[ xX]?\]\s+(.+)$/.exec(line);
    if (m) out.push(m[1].trim());
    if (out.length === 5) break;
  }
  return out;
}

export function toolCards(tools: ToolDefinition[], limit: number): string[] {
  return tools.slice(0, limit).map((t) =>
    `${t.name}: ${t.description}${t.readOnly ? " (read-only)" : ""}`);
}

export function injectGuidance(messages: ChatMessage[], blocks: string[]): ChatMessage[] {
  const kept = messages.filter((m) =>
    !(m.role === "system" && typeof m.content === "string" && m.content.startsWith(GUIDANCE_SENTINEL)));
  if (blocks.length === 0) return kept;
  const at = kept.length > 0 && kept[0].role === "system" ? 1 : 0;
  const block = `${GUIDANCE_SENTINEL}\n${blocks.join("\n")}\n--- end guidance ---`;
  return [...kept.slice(0, at), { role: "system" as const, content: block }, ...kept.slice(at)];
}

export class GuidanceState {
  private plan: string[] = [];
  constructor(private readonly opts: { taskId: string; toolCardLimit: number }) {}
  hasPlan(): boolean { return this.plan.length > 0; }
  requirePlan(): string {
    return "Start your reply with a short plan: up to 5 markdown checklist items (- [ ] ...).";
  }
  submitPlan(items: string[]): void {
    if (this.plan.length === 0 && items.length > 0) this.plan = items.slice(0, 5);
  }
  planItems(): readonly string[] { return this.plan; }
  get toolCardLimit(): number { return this.opts.toolCardLimit; }
}
