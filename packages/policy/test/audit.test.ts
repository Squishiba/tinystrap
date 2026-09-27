import { describe, expect, it } from "vitest";
import { makeEvent } from "@tinystrap/policy";

describe("audit events", () => {
  it("builds an event with required fields", () => {
    const e = makeEvent("t1", "tool_denied", { tool: "bash", reason: "git push forbidden" });
    expect(e.taskId).toBe("t1");
    expect(e.kind).toBe("tool_denied");
    expect(typeof e.timestamp).toBe("string");
    expect(e.reason).toBe("git push forbidden");
  });
});

describe("host-layer event kinds (spec 13.4)", () => {
  it("carries tool_executed with a tool name", () => {
    const e = makeEvent("t1", "tool_executed", { tool: "write" });
    expect(e.kind).toBe("tool_executed");
  });
  it("carries tool_failed and tool_call_repaired", () => {
    expect(makeEvent("t1", "tool_failed", { reason: "exit 1" }).kind).toBe("tool_failed");
    expect(makeEvent("t1", "tool_call_repaired", { tool: "edit" }).kind).toBe("tool_call_repaired");
  });
  it("carries host_event with the raw host type preserved", () => {
    const e = makeEvent("t1", "host_event", { hostEventType: "session.idle" });
    expect(e.hostEventType).toBe("session.idle");
  });
});

describe("verifier/promotion event kinds (spec 13.4)", () => {
  it("constructs the five lifecycle kinds", () => {
    expect(makeEvent("t1", "verification_started", { reason: "2 commands" }).kind)
      .toBe("verification_started");
    expect(makeEvent("t1", "verification_finished", { decision: "pass" }).kind)
      .toBe("verification_finished");
    expect(makeEvent("t1", "promotion_requested", { reason: "mode=apply" }).kind)
      .toBe("promotion_requested");
    expect(makeEvent("t1", "promotion_applied", { decision: "apply" }).kind)
      .toBe("promotion_applied");
    expect(makeEvent("t1", "promotion_refused", { reason: "drift" }).kind)
      .toBe("promotion_refused");
  });
});
