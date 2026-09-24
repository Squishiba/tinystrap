import { describe, expect, it } from "vitest";
import { buildDialect, createIdentityDialect } from "@tinystrap/policy";

describe("identity dialect", () => {
  const d = createIdentityDialect();
  it("passes names and args through unchanged", () => {
    expect(d.id).toBe("canonical");
    expect(d.supportsHarnessNotice).toBe(true);
    expect(d.canonicalName("edit")).toBe("edit");
    expect(d.toCanonicalArgs("edit", { path: "/w/a", oldText: "x" }))
      .toEqual({ path: "/w/a", oldText: "x" });
    expect(d.toHostArgs("edit", { path: "/w/a", oldText: "x" }))
      .toEqual({ path: "/w/a", oldText: "x" });
  });
  it("allows everything by default", () => {
    expect(d.disposition("webfetch")).toBe("allow");
  });
  it("toolDefinition fills defaults from the wire entry", () => {
    const def = d.toolDefinition({ type: "function",
      function: { name: "read", description: "reads", parameters: { type: "object" } } });
    expect(def).toEqual({ name: "read", description: "reads",
      inputSchema: { type: "object" }, capabilities: [], readOnly: false });
  });
});

describe("buildDialect with argument maps", () => {
  const d = buildDialect({ id: "demo", supportsHarnessNotice: false,
    argMaps: { edit: { filePath: "path", oldString: "oldText" } },
    readOnly: ["read"], dispositions: { webfetch: "deny" } });
  it("maps host args to canonical args, leaving unmapped keys alone", () => {
    expect(d.toCanonicalArgs("edit", { filePath: "/w/a", oldString: "x", replaceAll: true }))
      .toEqual({ path: "/w/a", oldText: "x", replaceAll: true });
  });
  it("maps canonical rewrite args back to host names (inverse map)", () => {
    expect(d.toHostArgs("edit", { path: "/w/a", oldText: "y", replaceAll: true }))
      .toEqual({ filePath: "/w/a", oldString: "y", replaceAll: true });
  });
  it("tools without an entry pass through", () => {
    expect(d.toCanonicalArgs("bash", { command: "ls" })).toEqual({ command: "ls" });
  });
  it("carries capabilities, readOnly and dispositions from the spec", () => {
    expect(d.disposition("webfetch")).toBe("deny");
    expect(d.disposition("edit")).toBe("allow");
    expect(d.toolDefinition({ type: "function", function: { name: "read" } }))
      .toMatchObject({ readOnly: true, capabilities: [] });
  });
  it("applies nameMap when present", () => {
    const n = buildDialect({ id: "nm", supportsHarnessNotice: true, argMaps: {},
      nameMap: { read_file: "read" } });
    expect(n.canonicalName("read_file")).toBe("read");
    expect(n.canonicalName("bash")).toBe("bash");
  });
});
