import type { Phase } from "@tinystrap/policy";

export type ModelProfile = {
  id: string;
  match: RegExp;
  toolAllowlist?: readonly string[];
  toolCardLimit?: number;
  thinking: { planning: boolean; mechanical: boolean };
  repairStrictness: "strict" | "lenient" | "off";
  budgetReserveTokens: number;
};

export const DEFAULT_PROFILE: ModelProfile = {
  id: "default",
  match: /.*/,
  toolCardLimit: 3,
  thinking: { planning: true, mechanical: true },
  repairStrictness: "strict",
  budgetReserveTokens: 1024,
};

export const BUILTIN_PROFILES: readonly ModelProfile[] = [
  {
    id: "qwen3",
    match: /qwen3/i,
    toolCardLimit: 2,
    thinking: { planning: true, mechanical: false },
    repairStrictness: "lenient",
    budgetReserveTokens: 2048,
  },
  DEFAULT_PROFILE,
];

export function selectProfile(modelId: string, profiles: readonly ModelProfile[] = BUILTIN_PROFILES) {
  return profiles.find((p) => p.match.test(modelId)) ?? DEFAULT_PROFILE;
}

export function thinkingKwargs(profile: ModelProfile, phase: Phase) {
  const on = phase === "planning" || phase === "verification"
    ? profile.thinking.planning : profile.thinking.mechanical;
  return { chat_template_kwargs: { enable_thinking: on } };
}

// Heuristic (gap 4): no dedicated enable_thinking caps key exists on llama.cpp;
// a template advertising tool support accepts chat_template_kwargs (spike A8). To verify.
export function supportsThinkingToggle(caps: Record<string, boolean> | null | undefined): boolean {
  return !!caps && caps.supports_tools === true;
}

export function thinkingForRequest(
  modelId: string, caps: Record<string, boolean> | null, phase: Phase,
  profiles: readonly ModelProfile[] = BUILTIN_PROFILES,
): { chat_template_kwargs?: { enable_thinking: boolean } } {
  if (!supportsThinkingToggle(caps)) return {};
  return thinkingKwargs(selectProfile(modelId, profiles), phase);
}
