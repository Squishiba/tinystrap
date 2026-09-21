import type { ChatMessage } from "./types.js";

export type NCtxScope = "total" | "per_slot" | "unknown";
export type BudgetInput = {
  nCtx: number; scope: NCtxScope; totalSlots: number; reserveTokens: number;
};
export type Budget = { windowTokens: number; warning?: string };

export function resolveBudget(input: BudgetInput): Budget {
  if (input.scope === "unknown") {
    return {
      windowTokens: Math.max(0, input.nCtx - input.reserveTokens),
      warning: "n_ctx scope unknown (A10): budgeting as shared total, never per-slot",
    };
  }
  return { windowTokens: Math.max(0, input.nCtx - input.reserveTokens) };
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function truncateHistory(messages: ChatMessage[], budgetTokens: number): ChatMessage[] {
  const [first, ...rest] = messages;
  const kept: ChatMessage[] = [];
  let used = first && first.role === "system"
    ? estimateTokens(first.content ?? "") : 0;
  const head = first && first.role === "system" ? [first] : [];
  if (first && first.role !== "system") rest.unshift(first);
  for (let i = rest.length - 1; i >= 0; i--) {
    const cost = estimateTokens(rest[i].content ?? "");
    if (used + cost > budgetTokens) break;
    kept.unshift(rest[i]); used += cost;
  }
  return [...head, ...kept];
}

const KEEP_LINE = /fail|error|summary|passed|failed/i;

export function condenseTestOutput(text: string): string {
  const lines = text.split(/\r?\n/);
  if (lines.length <= 2) return text;
  const kept = new Set([0, lines.length - 1]);
  lines.forEach((l, i) => { if (KEEP_LINE.test(l)) kept.add(i); });
  return lines.filter((_, i) => kept.has(i)).join("\n");
}
