import { describe, expect, it } from "vitest";
import { PIN_NOTE_TOOL, PIN_NOTE_TOOL_NAME, effectsForHarnessTool, createToolRegistry } from "@tinystrap/policy";

describe("pin_note harness tool", () => {
  it("is a valid non-read-only tool definition", () => {
    expect(PIN_NOTE_TOOL.name).toBe(PIN_NOTE_TOOL_NAME);
    expect(PIN_NOTE_TOOL.readOnly).toBe(false);
    expect(PIN_NOTE_TOOL.capabilities).toEqual(["harness_state_write"]);
    expect(PIN_NOTE_TOOL.inputSchema.required).toEqual(["key"]);
    const r = createToolRegistry();
    r.register(PIN_NOTE_TOOL);
    expect(r.lookup("pin_note")).toBe(PIN_NOTE_TOOL);
  });
  it("classifies as a harness-state write, not a filesystem write", () => {
    expect(effectsForHarnessTool("pin_note")).toEqual(
      [{ target: "harness:notes", kind: "write", scope: "in_workspace" }]);
    expect(effectsForHarnessTool("write")).toEqual([]);
  });
});