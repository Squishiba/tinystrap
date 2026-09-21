import { describe, expect, it } from "vitest";
import { EvasionTracker } from "@tinystrap/policy";
import type { EffectRecord } from "@tinystrap/policy";

const w = (t: string): EffectRecord =>
  ({ target: t, kind: "write", scope: "out_of_workspace" });

describe("evasion tracker", () => {
  it("flags same effect via another tool", () => {
    const tr = new EvasionTracker();
    tr.recordDenial([w("/etc/hosts")]);
    expect(tr.check([w("/etc/hosts")])).toEqual({ flagged: true, count: 1 });
    expect(tr.check([w("/etc/hosts")]).count).toBe(2);
    expect(tr.check([w("/other")]).flagged).toBe(false);
  });
  it("escalates strip -> correction -> stop", () => {
    const tr = new EvasionTracker();
    expect(tr.escalate(1)).toBe("strip_tool");
    expect(tr.escalate(2)).toBe("inject_correction");
    expect(tr.escalate(3)).toBe("stop");
    expect(tr.escalate(9)).toBe("stop");
  });
});
