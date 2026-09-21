import { describe, expect, it } from "vitest";
import { createToolRegistry } from "@tinystrap/policy";

const def = (name: string) => ({
  name, description: name, inputSchema: {}, capabilities: [], readOnly: false,
});

describe("tool registry", () => {
  it("registers and looks up tools", () => {
    const r = createToolRegistry();
    r.register(def("read"));
    expect(r.lookup("read")?.name).toBe("read");
    expect(r.lookup("nope")).toBeUndefined();
    expect(r.all().map((t) => t.name)).toEqual(["read"]);
  });
  it("rejects duplicate registration", () => {
    const r = createToolRegistry();
    r.register(def("read"));
    expect(() => r.register(def("read"))).toThrow(/duplicate/i);
  });
});
