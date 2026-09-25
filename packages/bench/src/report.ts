// Bench report rendering: markdown summary table + JSON dump. The markdown
// labels anything the run could not exercise: switches declared in the
// features table but without a server-side mechanism are listed as
// "declared, not ablated" instead of being silently absent.

import { writeFileSync } from "node:fs";
import { UNIMPLEMENTED_FEATURES } from "@tinystrap/proxy";
import type { BenchRunResult } from "./runner.js";

export function renderMarkdown(results: BenchRunResult[]): string {
  const header =
    "| task | config | resolved | turns | tokens (p/c) | denied | interrupted | repaired | evasion | reasoning | wall ms |";
  const sep =
    "| ---- | ------ | -------- | ----- | ------------ | ------ | ----------- | -------- | ------- | --------- | ------- |";
  const rows = results.map((r) => [
    `| ${r.taskId}`,
    `| ${r.config}`,
    `| ${r.resolved ? "yes" : "no"}`,
    `| ${r.metrics.turns}`,
    `| ${r.metrics.tokensPrompt}/${r.metrics.tokensCompletion}`,
    `| ${r.metrics.toolDenied}`,
    `| ${r.metrics.toolInterrupted}`,
    `| ${r.metrics.toolCallRepaired}`,
    `| ${r.metrics.evasionFlagged}`,
    `| ${r.metrics.reasoningInterventions}`,
    `| ${r.metrics.wallMs} |`,
  ].join(" "));
  const parts = ["# Bench report", "", header, sep, ...rows];
  if (UNIMPLEMENTED_FEATURES.length > 0) {
    parts.push(
      "",
      `Declared but not ablated (no server-side mechanism): ${UNIMPLEMENTED_FEATURES.join(", ")}.`,
    );
  }
  return `${parts.join("\n")}\n`;
}

export function writeJsonReport(path: string, results: BenchRunResult[]): void {
  writeFileSync(path, `${JSON.stringify(results, null, 2)}\n`);
}
