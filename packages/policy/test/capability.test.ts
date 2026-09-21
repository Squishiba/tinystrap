import { describe, expect, it } from "vitest";
import { compileToolList, createToolRegistry } from "@tinystrap/policy";

const def = (name: string) => ({
  name, description: name, inputSchema: {}, capabilities: [], readOnly: false,
});

describe("capability compiler", () => {
  it("filters by phase allowlist", () => {
    const r = createToolRegistry();
    for (const n of ["read", "grep", "edit", "bash"]) r.register(def(n));
    const planning = compileToolList("planning", r, { planning: ["read", "grep"] });
    expect(planning.map((t) => t.name)).toEqual(["read", "grep"]);
    expect(compileToolList("implementation", r, { planning: ["read"] }).length).toBe(4);
  });
  it("promotion phase can be empty", () => {
    const r = createToolRegistry();
    r.register(def("read"));
    expect(compileToolList("promotion", r, { promotion: [] })).toEqual([]);
  });
});
