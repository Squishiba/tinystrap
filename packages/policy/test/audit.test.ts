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
