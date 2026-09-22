import { describe, expect, it } from "vitest";
import { parseOpenCodeJsonl } from "@tinystrap/adapter-opencode";

const L = (o: unknown) => JSON.stringify(o);

describe("parseOpenCodeJsonl", () => {
  it("maps tool events to tool_executed / tool_failed", () => {
    const events = parseOpenCodeJsonl("t1", [
      L({ type: "tool_use", tool: "write", callID: "c1" }),
      L({ type: "tool_result", tool: "write", callID: "c1", output: "ok" }),
      L({ type: "tool_error", tool: "edit", callID: "c2", error: "oldText not found" }),
    ]);
    expect(events.map((e) => e.kind)).toEqual(["tool_executed", "tool_executed", "tool_failed"]);
    expect(events[0].tool).toBe("write");
    expect(events[2].reason).toBe("oldText not found");
  });
  it("keeps unmapped types losslessly as host_event", () => {
    const events = parseOpenCodeJsonl("t1", [L({ type: "session.idle" }), L({ type: "step_finish" })]);
    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe("host_event");
    expect(events[0].hostEventType).toBe("session.idle");
  });
  it("survives blank and malformed lines", () => {
    const events = parseOpenCodeJsonl("t1", ["", "{not json", L({ type: "text", text: "hi" })]);
    expect(events).toHaveLength(3);
    expect(events[1].kind).toBe("host_event");
    expect(events[1].hostEventType).toBe("unparsed");
    expect(events[2].kind).toBe("host_event");
    expect(events[2].hostEventType).toBe("text");
  });
});