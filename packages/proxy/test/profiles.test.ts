import { describe, expect, it } from "vitest";
import { BUILTIN_PROFILES, DEFAULT_PROFILE, selectProfile, thinkingKwargs } from "@tinystrap/proxy";

describe("profiles", () => {
  it("matches the qwen3 family and turns mechanical thinking off", () => {
    const p = selectProfile("/models/Qwen3.8-Flash-Next-AP-Q4_K_M.gguf");
    expect(p.id).not.toBe(DEFAULT_PROFILE.id);
    expect(p.thinking).toEqual({ planning: true, mechanical: false });
  });
  it("unknown models get the conservative default", () => {
    expect(selectProfile("mystery-70b").id).toBe(DEFAULT_PROFILE.id);
    expect(DEFAULT_PROFILE.thinking.planning).toBe(true);
    expect(DEFAULT_PROFILE.thinking.mechanical).toBe(true);
  });
  it("thinkingKwargs emits the spike-verified request shape", () => {
    const p = BUILTIN_PROFILES.find((x) => x.id !== DEFAULT_PROFILE.id)!;
    expect(thinkingKwargs(p, "planning")).toEqual({ chat_template_kwargs: { enable_thinking: true } });
    expect(thinkingKwargs(p, "implementation")).toEqual({ chat_template_kwargs: { enable_thinking: false } });
  });
});
