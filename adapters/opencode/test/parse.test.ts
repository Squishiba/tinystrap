import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseOpenCodeJsonl } from "@tinystrap/adapter-opencode";

const L = (o: unknown) => JSON.stringify(o);
const FIXTURE_URL = new URL(
  "../../../docs/superpowers/spike-findings/fixtures/opencode-run-events.jsonl",
  import.meta.url,
);
const fixtureLines = () => readFileSync(FIXTURE_URL, "utf8").split("\n").filter((l) => l.length > 0);

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
  it("parses the recorded real-host fixture into the expected event sequence", () => {
    const events = parseOpenCodeJsonl("t1", fixtureLines());
    expect(events).toHaveLength(9);
    expect(events.map((e) => e.kind)).toEqual([
      "host_event", // step_start
      "tool_executed", // tool_use read
      "host_event", // step_finish
      "host_event", // step_start
      "tool_executed", // tool_use edit
      "host_event", // step_finish
      "host_event", // step_start
      "host_event", // text
      "host_event", // step_finish
    ]);
    const executed = events.filter((e) => e.kind === "tool_executed");
    expect(executed.map((e) => e.tool)).toEqual(["read", "edit"]);
  });
  it("maps a synthetic tool_use failure shape to tool_failed (unobserved, inferred)", () => {
    const events = parseOpenCodeJsonl("t1", [
      L({
        type: "tool_use",
        part: { type: "tool", tool: "edit", callID: "call_1", state: { status: "error", error: "oldString not found" } },
      }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("tool_failed");
    expect(events[0].tool).toBe("edit");
    expect(events[0].reason).toBe("oldString not found");
  });
  it("keeps tool_use events with an unknown status as host_event", () => {
    const events = parseOpenCodeJsonl("t1", [
      L({
        type: "tool_use",
        part: { type: "tool", tool: "read", callID: "call_0", state: { status: "running" } },
      }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("host_event");
    expect(events[0].hostEventType).toBe("tool_use");
  });
  it("tolerates CRLF line endings", () => {
    const crlf = fixtureLines().map((l) => `${l}\r`);
    const events = parseOpenCodeJsonl("t1", crlf);
    expect(events.map((e) => e.kind)).toEqual(parseOpenCodeJsonl("t1", fixtureLines()).map((e) => e.kind));
  });
  it("never drops lines: one event per input line including blank and malformed", () => {
    const lines = [L({ type: "tool_use", tool: "write", callID: "c1" }), "", "{not json", L({ type: "step_finish" })];
    const events = parseOpenCodeJsonl("t1", lines);
    expect(events).toHaveLength(lines.length);
    expect(events.map((e) => [e.kind, e.hostEventType])).toEqual([
      ["tool_executed", undefined],
      ["host_event", "blank"],
      ["host_event", "unparsed"],
      ["host_event", "step_finish"],
    ]);
  });
});
