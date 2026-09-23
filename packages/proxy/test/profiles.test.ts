import { describe, expect, it } from "vitest";
import { selectProfile, thinkingKwargs } from "@tinystrap/proxy";
import { supportsThinkingToggle, thinkingForRequest, BUILTIN_PROFILES, DEFAULT_PROFILE } from "@tinystrap/proxy";

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

describe("capability-gated thinking (spec 12.1/12.6)", () => {
  const caps = { supports_tools: true, supports_tool_calls: true };
  it("supportsThinkingToggle requires a caps object with supports_tools", () => {
    expect(supportsThinkingToggle(caps)).toBe(true);
    expect(supportsThinkingToggle({})).toBe(false);
    expect(supportsThinkingToggle(null)).toBe(false);
    expect(supportsThinkingToggle(undefined)).toBe(false);
  });
  it("thinkingForRequest emits per-phase kwargs when supported", () => {
    expect(thinkingForRequest("qwen3-x", caps, "planning"))
      .toEqual({ chat_template_kwargs: { enable_thinking: true } });
    expect(thinkingForRequest("qwen3-x", caps, "implementation"))
      .toEqual({ chat_template_kwargs: { enable_thinking: false } });
  });
  it("thinkingForRequest emits nothing when unsupported", () => {
    expect(thinkingForRequest("qwen3-x", null, "planning")).toEqual({});
  });
  it("profiles carry a toolCardLimit", () => {
    expect(DEFAULT_PROFILE.toolCardLimit).toBe(3);
    expect(BUILTIN_PROFILES.find((p) => p.id === "qwen3")!.toolCardLimit).toBe(2);
  });
});
