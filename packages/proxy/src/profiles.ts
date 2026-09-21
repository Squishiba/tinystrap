import type { Phase } from "@tinystrap/policy";

export type ModelProfile = {
  id: string;
  match: RegExp;
  toolAllowlist?: readonly string[];
  thinking: { planning: boolean; mechanical: boolean };
  repairStrictness: "strict" | "lenient" | "off";
  budgetReserveTokens: number;
};

export const DEFAULT_PROFILE: ModelProfile = {
  id: "default",
  match: /.*/,
  thinking: { planning: true, mechanical: true },
  repairStrictness: "strict",
  budgetReserveTokens: 1024,
};

export const BUILTIN_PROFILES: readonly ModelProfile[] = [
  {
    id: "qwen3",
    match: /qwen3/i,
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
