import { describe, expect, it } from "vitest";
import { checkEditSyntax } from "@tinystrap/core";

describe("checkEditSyntax", () => {
  it("accepts valid javascript", async () => {
    expect(await checkEditSyntax("a.js", "const x = 1;\n")).toEqual({ ok: true });
  });
  it("reports the first javascript syntax error", async () => {
    const r = await checkEditSyntax("a.js", "function f( {\n");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.split("\n")[0].length).toBeGreaterThan(0);
  });
  it("accepts valid python", async () => {
    expect(await checkEditSyntax("m.py", "def f():\n    return 1\n")).toEqual({ ok: true });
    // python subprocess startup is slow on loaded Windows runners; 20_000
    // keeps the per-test deadline far above the measured 5 s CI spikes.
  }, 20_000);
  it("reports the first python syntax error", async () => {
    const r = await checkEditSyntax("m.py", "def f(:\n");
    expect(r.ok).toBe(false);
  }, 20_000);
  it("skips unsupported extensions", async () => {
    expect(await checkEditSyntax("x.ts", "this is not code at all {{{")).toEqual({ ok: true });
  });
});
