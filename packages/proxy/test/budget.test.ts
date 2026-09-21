import { describe, expect, it } from "vitest";
import { condenseTestOutput, estimateTokens, resolveBudget, truncateHistory } from "@tinystrap/proxy";

describe("budget", () => {
  it("unknown scope budgets as shared total with a warning, never per-slot", () => {
    const b = resolveBudget({ nCtx: 128000, scope: "unknown", totalSlots: 4, reserveTokens: 2048 });
    expect(b.windowTokens).toBe(128000 - 2048);
    expect(b.warning).toMatch(/A10/);
  });
  it("per_slot scope uses nCtx directly", () => {
    expect(resolveBudget({ nCtx: 8192, scope: "per_slot", totalSlots: 4, reserveTokens: 0 })
      .windowTokens).toBe(8192);
  });
  it("never goes negative", () => {
    expect(resolveBudget({ nCtx: 100, scope: "total", totalSlots: 1, reserveTokens: 500 })
      .windowTokens).toBe(0);
  });
  it("truncates oldest-first but keeps the system message", () => {
    const msgs = [
      { role: "system" as const, content: "sys" },
      ...Array.from({ length: 10 }, (_, i) =>
        ({ role: "user" as const, content: "x".repeat(400) })),
    ];
    const kept = truncateHistory(msgs, 500);
    expect(kept[0].role).toBe("system");
    expect(kept.length).toBeLessThan(msgs.length);
    expect(kept[kept.length - 1].content).toBe("x".repeat(400));
  });
  it("condenses test output to failures and summaries", () => {
    const out = ["build start", "ok thing a", "FAIL src/x.test.ts", "more noise",
      "Summary: 1 failed, 20 passed"].join("\n");
    const c = condenseTestOutput(out);
    expect(c).toContain("FAIL");
    expect(c).toContain("Summary");
    expect(c).not.toContain("ok thing a");
  });
});
