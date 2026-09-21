import { describe, expect, it } from "vitest";
import { ScriptLedger } from "@tinystrap/policy";

describe("script provenance", () => {
  it("runs a clean unchanged script", () => {
    const l = new ScriptLedger();
    l.recordWrite("s.py", "h1", "clean");
    expect(l.checkExec("s.py", "h1")).toBe("run");
  });
  it("rescans unknown or mutated scripts", () => {
    const l = new ScriptLedger();
    expect(l.checkExec("new.py", "h")).toBe("rescan");
    l.recordWrite("s.py", "h1", "clean");
    expect(l.checkExec("s.py", "h2")).toBe("rescan");
  });
  it("redecides a known-dangerous script", () => {
    const l = new ScriptLedger();
    l.recordWrite("s.py", "h1", "dangerous");
    expect(l.checkExec("s.py", "h1")).toBe("redecide");
  });
});
