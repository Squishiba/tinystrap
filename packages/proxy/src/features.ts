export type ProxyFeatures = {
  tool_call_repair: boolean;
  context_budgeting: boolean;
  reasoning_control: boolean;
  edit_assistance: boolean;
  guidance: boolean;
  pinned_notes: boolean;
  // Plan-level switch (host-dialects plan Task 9), not a spec 7 mechanism —
  // pending the spec 7 config-table update.
  interruption_feedback: boolean;
  // Bounded proxy-side retry of gate-denied tool calls: instead of surfacing
  // the interruption to the host, re-call the provider in the same client SSE
  // stream with the attempted call plus a correction tool message.
  interruption_retry: boolean;
};

export const DEFAULT_FEATURES: ProxyFeatures = {
  tool_call_repair: true, context_budgeting: true, reasoning_control: true,
  edit_assistance: true, guidance: true, pinned_notes: true,
  interruption_feedback: true, interruption_retry: true,
};

// Declared per spec 7; no server-side mechanism exists yet (spec-vs-code gap, reported).
// runAblation refuses to treat disabling these as an experiment.
export const UNIMPLEMENTED_FEATURES: readonly (keyof ProxyFeatures)[] = [];
