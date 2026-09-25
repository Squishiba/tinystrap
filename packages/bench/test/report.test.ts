import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BenchRunResult } from "@tinystrap/bench";
import { renderMarkdown, writeJsonReport } from "@tinystrap/bench";

function result(config: string, taskId: string, resolved: boolean): BenchRunResult {
  return {
    taskId,
    config,
    resolved,
    metrics: {
      turns: 3, tokensPrompt: 100, tokensCompletion: 20, wallMs: 1234,
      toolDenied: 1, toolInterrupted: 2, toolCallRepaired: 4,
      evasionFlagged: 5, reasoningInterventions: 6,
    },
    verify: null,
    hostResult: null,
  };
}

describe("renderMarkdown", () => {
  it("renders one header row and one data row per result", () => {
    const md = renderMarkdown([
      result("full", "ts-off-by-one", true),
      result("no-tool-call-repair", "ts-off-by-one", false),
    ]);
    const rows = md.split("\n").filter((line) => line.trim().startsWith("|"));
    expect(rows.length).toBe(4); // header + separator + 2 data rows
    expect(rows[0]).toContain("config");
    expect(rows[2]).toContain("full");
    expect(rows[2]).toContain("yes"); // full run resolved
    expect(rows[3]).toContain("no-tool-call-repair");
    expect(rows[3]).toContain("| no |"); // second run not resolved
    for (const row of rows.slice(2)) {
      expect(row).toContain("ts-off-by-one");
      expect(row).toContain("1"); // toolDenied
      expect(row).toContain("4"); // toolCallRepaired
    }
  });
});

describe("writeJsonReport", () => {
  it("round-trips through JSON.parse", () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-report-"));
    try {
      const path = join(dir, "report.json");
      const results = [result("full", "ts-off-by-one", true), result("bare", "py-factorial", false)];
      writeJsonReport(path, results);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(results);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
