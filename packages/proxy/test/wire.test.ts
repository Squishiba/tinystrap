import { describe, expect, it } from "vitest";
import { createOpenCodeDialect, createToolRegistry, PIN_NOTE_TOOL } from "@tinystrap/policy";
import type { ToolDefinition } from "@tinystrap/policy";
import { compileForwardedTools, toWireTool } from "@tinystrap/proxy";

function def(name: string): ToolDefinition {
  return { name, description: name, inputSchema: { type: "object" }, capabilities: [], readOnly: false };
}

function registryWith(...names: string[]) {
  const r = createToolRegistry();
  for (const n of names) r.register(def(n));
  return r;
}

describe("toWireTool", () => {
  it("maps inputSchema to the wire parameters key", () => {
    expect(toWireTool(def("read"))).toEqual({ type: "function",
      function: { name: "read", description: "read", parameters: { type: "object" } } });
  });
});

describe("compileForwardedTools", () => {
  const dialect = createOpenCodeDialect();
  it("omits disposition-denied tools from the forwarded array (spec 9.6)", () => {
    const r = registryWith("read", "edit", "webfetch", "task", "skill");
    const names = compileForwardedTools({ registry: r, phase: "implementation", dialect })
      .map((t) => t.function.name);
    expect(names.sort()).toEqual(["edit", "read"]);
  });
  it("omits phase-denied tools via compileToolList", () => {
    const r = registryWith("read", "edit");
    const names = compileForwardedTools({ registry: r, phase: "planning", dialect,
      phaseAllowlists: { planning: ["read"] } }).map((t) => t.function.name);
    expect(names).toEqual(["read"]);
  });
  it("appends harness-owned extras once, even when the phase allowlist excludes them", () => {
    const r = registryWith("read");
    const names = compileForwardedTools({ registry: r, phase: "planning", dialect,
      phaseAllowlists: { planning: ["read"] }, extraTools: [PIN_NOTE_TOOL] })
      .map((t) => t.function.name);
    expect(names).toEqual(["read", "pin_note"]);
    const r2 = registryWith("read", "pin_note");
    const names2 = compileForwardedTools({ registry: r2, phase: "implementation", dialect,
      extraTools: [PIN_NOTE_TOOL] }).map((t) => t.function.name);
    expect(names2.filter((n) => n === "pin_note")).toEqual(["pin_note"]);   // deduped
  });
});
