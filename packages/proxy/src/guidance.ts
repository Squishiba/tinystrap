import type { ToolDefinition } from "@tinystrap/policy";
import type { ChatMessage, ToolCall } from "./types.js";

export type StallLevel = "none" | "nudge" | "replan" | "stop";
export const STALL_NUDGE = "Harness: you appear stuck (repeated identical actions). State what changed and take a different concrete step.";
export const STALL_REPLAN = "Harness: repeated stalling. Discard the current approach, write a new short plan, and take one different action.";

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
  private callCounts = new Map<string, number>();
  private readCounts = new Map<string, number>();
  private seenNewText = new Map<string, Set<string>>();
  private stalls = 0;
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

  recordCalls(calls: ToolCall[]): boolean {
    let stalled = false;
    for (const c of calls) {
      const n = (this.callCounts.get(`${c.function.name}:${c.function.arguments}`) ?? 0) + 1;
      this.callCounts.set(`${c.function.name}:${c.function.arguments}`, n);
      if (n >= 3) stalled = true;
      if (c.function.name === "read") {
        try {
          const p = String((JSON.parse(c.function.arguments) as { path?: string }).path ?? "");
          if (p !== "") {
            const r = (this.readCounts.get(p) ?? 0) + 1;
            this.readCounts.set(p, r);
            if (r >= 4) stalled = true;
          }
        } catch { /* unparseable args: identical-call signal already covers it */ }
      }
      if (c.function.name === "edit") {
        try {
          const a = JSON.parse(c.function.arguments) as { path?: string; newText?: string };
          if (typeof a.path === "string" && typeof a.newText === "string") {
            const seen = this.seenNewText.get(a.path) ?? new Set<string>();
            if (seen.has(a.newText)) stalled = true;
            seen.add(a.newText);
            this.seenNewText.set(a.path, seen);
          }
        } catch { /* as above */ }
      }
    }
    return stalled;
  }

  escalate(): StallLevel {
    this.stalls += 1;
    if (this.stalls === 1) return "nudge";
    if (this.stalls === 2) return "replan";
    return "stop";
  }

  stallCount(): number { return this.stalls; }
}
