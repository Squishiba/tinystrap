import { createToolRegistry } from "@tinystrap/policy";
import { describe, expect, it } from "vitest";
import { repairToolCalls } from "@tinystrap/proxy";

const reg = () => {
  const r = createToolRegistry();
  for (const n of ["read", "edit"]) {
    r.register({ name: n, description: n, inputSchema: {}, capabilities: [], readOnly: false });
  }
  return r;
};
const call = (name: string, args: string) =>
  ({ id: "c", type: "function" as const, function: { name, arguments: args } });

describe("tool-call repair", () => {
  it("fixes near-miss names by edit distance", () => {
    const out = repairToolCalls([call("read_file", "{}")], reg());
    expect(out.calls[0].function.name).toBe("read");
    expect(out.repairs.join()).toContain("read_file->read");
  });
  it("maps aliased argument names", () => {
    const out = repairToolCalls([call("edit", '{"file_path":"a.ts"}')], reg(),
      { aliases: { edit: { file_path: "path" } } });
    expect(out.calls[0].function.arguments).toContain('"path":"a.ts"');
    expect(out.repairs.join()).toContain("arg:file_path->path");
  });
  it("closes truncated JSON arguments", () => {
    const out = repairToolCalls([call("read", '{"path":"a.ts"')], reg());
    expect(JSON.parse(out.calls[0].function.arguments)).toEqual({ path: "a.ts" });
    expect(out.repairs.join()).toContain("json:closed");
  });
  it("passes unrepairable calls through", () => {
    const out = repairToolCalls([call("quantum_fax", "not json {{{")], reg());
    expect(out.calls[0].function.name).toBe("quantum_fax");
    expect(out.repairs).toEqual([]);
  });
});
