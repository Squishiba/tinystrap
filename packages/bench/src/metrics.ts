// Spec-15 metrics, taken from proxy audit events (HarnessEvents), never by
// parsing host output: turns = tool_stream_started, denials = tool_denied +
// tool_interrupted, repairs = tool_call_repaired, evasion = evasion_flagged,
// reasoning interventions = reasoning_intervention, tokens = model_usage.

import type { HarnessEvent } from "@tinystrap/policy";

export type BenchMetrics = {
  turns: number;
  tokensPrompt: number;
  tokensCompletion: number;
  wallMs: number;
  toolDenied: number;
  toolInterrupted: number;
  toolCallRepaired: number;
  evasionFlagged: number;
  reasoningInterventions: number;
};

export function collectMetrics(events: HarnessEvent[], wallMs: number): BenchMetrics {
  const m: BenchMetrics = {
    turns: 0,
    tokensPrompt: 0,
    tokensCompletion: 0,
    wallMs,
    toolDenied: 0,
    toolInterrupted: 0,
    toolCallRepaired: 0,
    evasionFlagged: 0,
    reasoningInterventions: 0,
  };
  for (const e of events) {
    switch (e.kind) {
      case "tool_stream_started": m.turns++; break;
      case "model_usage":
        m.tokensPrompt += e.usage?.prompt ?? 0;
        m.tokensCompletion += e.usage?.completion ?? 0;
        break;
      case "tool_denied": m.toolDenied++; break;
      case "tool_interrupted": m.toolInterrupted++; break;
      case "tool_call_repaired": m.toolCallRepaired++; break;
      case "evasion_flagged": m.evasionFlagged++; break;
      case "reasoning_intervention": m.reasoningInterventions++; break;
    }
  }
  return m;
}
