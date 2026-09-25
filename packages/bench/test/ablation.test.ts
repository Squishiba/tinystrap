import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_FEATURES, UNIMPLEMENTED_FEATURES } from "@tinystrap/proxy";
import type { ProxyFeatures } from "@tinystrap/proxy";
import {
  TIER1_MATRIX,
  assertAblatable,
  implementedFeatures,
  loadTask,
  loadTasks,
  runAblation,
} from "@tinystrap/bench";
import { FakeHostRunner } from "./helpers/fakehost.js";

const tasksRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "tasks");

const FIXED_SUM = [
  "export function sum(nums) {",
  "  let total = 0;",
  "  for (let i = 0; i < nums.length; i++) total += nums[i];",
  "  return total;",
  "}",
  "",
].join("\n");

describe("TIER1_MATRIX", () => {
  it("is derived from the current features table, not a hard-coded list", () => {
    const implemented = implementedFeatures();
    // Every DEFAULT_FEATURES key is either implemented or declared unimplemented.
    for (const key of Object.keys(DEFAULT_FEATURES) as (keyof ProxyFeatures)[]) {
      expect(
        implemented.includes(key) || UNIMPLEMENTED_FEATURES.includes(key),
        key,
      ).toBe(true);
    }
    expect(TIER1_MATRIX[0]).toEqual({ label: "full", disabled: [] });
    const bare = TIER1_MATRIX[TIER1_MATRIX.length - 1];
    expect(bare.label).toBe("bare");
    expect([...bare.disabled].sort()).toEqual([...implemented].sort());
    expect(TIER1_MATRIX.length).toBe(implemented.length + 2);
    // Honesty rule: no config disables a switch without a mechanism.
    for (const cfg of TIER1_MATRIX) {
      for (const name of cfg.disabled) {
        expect(implemented, `${cfg.label}: ${name}`).toContain(name);
      }
    }
  });
});

describe("assertAblatable", () => {
  it("throws naming the feature and 'unimplemented' for a mechanism-less switch", () => {
    expect(() => assertAblatable(["pinned_notes"], ["pinned_notes"])).toThrow(
      /pinned_notes.*unimplemented/,
    );
  });

  it("accepts every name in the real matrix against the real table", () => {
    for (const cfg of TIER1_MATRIX) expect(() => assertAblatable(cfg.disabled)).not.toThrow();
  });
});

describe("runAblation", () => {
  it("runs a coding task once per config label, all resolved", async () => {
    const task = loadTask(join(tasksRoot, "ts-off-by-one"));
    const results = await runAblation([task], new FakeHostRunner((dir) => {
      writeFileSync(join(dir, "sum.js"), FIXED_SUM);
    }));
    expect(results.length).toBe(TIER1_MATRIX.length);
    expect(results.map((r) => r.config)).toEqual(TIER1_MATRIX.map((c) => c.label));
    for (const r of results) {
      expect(r.taskId).toBe("ts-off-by-one");
      expect(r.resolved, r.config).toBe(true);
      expect(r.verify?.passed, r.config).toBe(true);
    }
  }, 300_000);

  it("runs safety scenarios under every config too", async () => {
    const safety = loadTasks(tasksRoot).filter((t) => t.kind === "safety");
    const results = await runAblation(safety, new FakeHostRunner(() => {}), [
      { label: "full", disabled: [] },
      { label: "no-tool-call-repair", disabled: ["tool_call_repair"] },
    ]);
    expect(results.length).toBe(safety.length * 2);
    for (const r of results) expect(r.resolved, `${r.taskId}/${r.config}`).toBe(true);
  }, 120_000);

  it("refuses a matrix that disables an unimplemented switch", () => {
    if (UNIMPLEMENTED_FEATURES.length === 0) {
      // Every declared switch has a mechanism on main right now; the guard
      // itself is covered by the assertAblatable test above with a fake table.
      return;
    }
    const bad = [{ label: "x", disabled: [UNIMPLEMENTED_FEATURES[0]!] }];
    expect(() => runAblation([], new FakeHostRunner(() => {}), bad)).toThrow(
      new RegExp(`${UNIMPLEMENTED_FEATURES[0]}.*unimplemented`),
    );
  });
});
