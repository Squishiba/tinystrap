import { describe, expect, it } from "vitest";
import { makeEvent } from "@tinystrap/policy";
import type { HarnessEvent } from "@tinystrap/policy";
import { collectMetrics } from "@tinystrap/bench";

const events: HarnessEvent[] = [
  makeEvent("t", "tool_stream_started"),
  makeEvent("t", "tool_stream_started"),
  makeEvent("t", "model_usage", { usage: { prompt: 100, completion: 20 } }),
  makeEvent("t", "tool_denied"),
  makeEvent("t", "tool_interrupted"),
  makeEvent("t", "tool_call_repaired"),
  makeEvent("t", "evasion_flagged"),
  makeEvent("t", "reasoning_intervention"),
];

describe("collectMetrics", () => {
  it("counts every spec-15 metric from harness events", () => {
    expect(collectMetrics(events, 1234)).toEqual({
      turns: 2,
      tokensPrompt: 100,
      tokensCompletion: 20,
      wallMs: 1234,
      toolDenied: 1,
      toolInterrupted: 1,
      toolCallRepaired: 1,
      evasionFlagged: 1,
      reasoningInterventions: 1,
    });
  });

  it("returns all zeros for an empty event list", () => {
    expect(collectMetrics([], 0)).toEqual({
      turns: 0,
      tokensPrompt: 0,
      tokensCompletion: 0,
      wallMs: 0,
      toolDenied: 0,
      toolInterrupted: 0,
      toolCallRepaired: 0,
      evasionFlagged: 0,
      reasoningInterventions: 0,
    });
  });

  it("sums usage across multiple model_usage events", () => {
    const two = [
      makeEvent("t", "model_usage", { usage: { prompt: 10, completion: 1 } }),
      makeEvent("t", "model_usage", { usage: { prompt: 5, completion: 2 } }),
    ];
    const m = collectMetrics(two, 0);
    expect(m.tokensPrompt).toBe(15);
    expect(m.tokensCompletion).toBe(3);
  });
});
