// Tier-1 ablation runner (spec 7 + 15): re-run the suite with individual
// small-model mechanisms disabled. The matrix is DERIVED from the current
// proxy features table — full, one config per implemented switch, and bare
// (all implemented switches off) — so it can never drift from features.ts.
// Honesty rule: a switch without a server-side mechanism (UNIMPLEMENTED_
// FEATURES) may not be ablated; runAblation refuses instead of silently
// no-op-ing. Safety scenarios run under every config too: a switch that
// unblocks a safety scenario is the most interesting tier-1 result.

import { DEFAULT_FEATURES, UNIMPLEMENTED_FEATURES } from "@tinystrap/proxy";
import type { ProxyFeatures } from "@tinystrap/proxy";
import type { HostRunner } from "@tinystrap/core";
import type { BenchTask } from "./taskfile.js";
import type { BenchRunResult } from "./runner.js";
import { runTask } from "./runner.js";
import { runSafetyScenario } from "./safety.js";

export type AblationConfig = { label: string; disabled: (keyof ProxyFeatures)[] };

export function implementedFeatures(): (keyof ProxyFeatures)[] {
  return (Object.keys(DEFAULT_FEATURES) as (keyof ProxyFeatures)[])
    .filter((name) => !UNIMPLEMENTED_FEATURES.includes(name));
}

// Guard shared by runAblation and the matrix builder. `unimplemented` is
// injectable so the refusal is testable even while the real table is empty.
export function assertAblatable(
  disabled: readonly (keyof ProxyFeatures)[],
  unimplemented: readonly (keyof ProxyFeatures)[] = UNIMPLEMENTED_FEATURES,
): void {
  for (const name of disabled) {
    if (unimplemented.includes(name)) {
      throw new Error(
        `ablation refuses to disable "${name}": unimplemented feature, no server-side mechanism to ablate`,
      );
    }
  }
}

export const TIER1_MATRIX: AblationConfig[] = [
  { label: "full", disabled: [] },
  ...implementedFeatures().map((name) => ({
    label: `no-${name.replace(/_/g, "-")}`,
    disabled: [name] as (keyof ProxyFeatures)[],
  })),
  { label: "bare", disabled: implementedFeatures() },
];

export async function runAblation(
  tasks: BenchTask[],
  host: HostRunner,
  matrix: AblationConfig[] = TIER1_MATRIX,
): Promise<BenchRunResult[]> {
  for (const cfg of matrix) assertAblatable(cfg.disabled);
  const results: BenchRunResult[] = [];
  for (const cfg of matrix) {
    const features = Object.fromEntries(
      cfg.disabled.map((name) => [name, false]),
    ) as Partial<ProxyFeatures>;
    for (const task of tasks) {
      // Every (config, task) pair runs fresh: runTask/runSafetyScenario each
      // build their own temp workspace, proxy, and gate — no reuse.
      results.push(task.kind === "safety"
        ? await runSafetyScenario(task, { features, config: cfg.label })
        : await runTask(task, { host, features, config: cfg.label }));
    }
  }
  return results;
}
