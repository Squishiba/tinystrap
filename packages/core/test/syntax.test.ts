import { describe, expect, it } from "vitest";
import { checkEditSyntax, checkPython, PYTHON_CANDIDATES } from "@tinystrap/core";

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

  // These pin the ENOENT-retry behavior deterministically regardless of
  // which of python/python3 this box actually has, by putting a definitely-
  // missing binary ahead of both real candidate names — CI must already
  // have at least one working (the tests above depend on it), so this
  // exercises the exact retry path without hardcoding which one.
  it("falls back past a missing interpreter to a working one", async () => {
    const r = await checkPython("def f():\n    return 1\n",
      ["definitely-not-a-real-binary-xyz", ...PYTHON_CANDIDATES]);
    expect(r).toEqual({ ok: true });
  }, 20_000);
  it("reports a clear error when no candidate interpreter exists", async () => {
    const r = await checkPython("def f():\n    return 1\n", ["definitely-not-a-real-binary-xyz"]);
    expect(r).toEqual({ ok: false, error: "python interpreter not found" });
  });
});
