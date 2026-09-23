import { describe, expect, it } from "vitest";
import { DEFAULT_FEATURES, UNIMPLEMENTED_FEATURES } from "@tinystrap/proxy";
import type { ProxyFeatures } from "@tinystrap/proxy";

const SPEC_7_NAMES: (keyof ProxyFeatures)[] = [
  "tool_call_repair", "context_budgeting", "reasoning_control",
  "edit_assistance", "guidance", "pinned_notes",
];

describe("ProxyFeatures", () => {
  it("declares all six spec-7 mechanisms, defaulted on", () => {
    for (const name of SPEC_7_NAMES) expect(DEFAULT_FEATURES[name]).toBe(true);
    expect(Object.keys(DEFAULT_FEATURES).sort()).toEqual([...SPEC_7_NAMES].sort());
  });

  it("marks exactly the two mechanisms that have no server implementation", () => {
    expect([...UNIMPLEMENTED_FEATURES].sort()).toEqual(
      ["edit_assistance", "guidance"].sort());
  });

  it("covers every declared key with exactly one of the two lists", () => {
    for (const key of Object.keys(DEFAULT_FEATURES) as (keyof ProxyFeatures)[]) {
      const declared = SPEC_7_NAMES.includes(key);
      expect(declared).toBe(true);
      expect(UNIMPLEMENTED_FEATURES.includes(key)).toBe(
        ["edit_assistance", "guidance"].includes(key));
    }
  });
});
