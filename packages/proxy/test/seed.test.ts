import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createIdentityDialect, createOpenCodeDialect, createToolRegistry } from "@tinystrap/policy";
import type { WireTool } from "@tinystrap/policy";
import { canonicalizeCalls, seedRegistry } from "@tinystrap/proxy";

const fixturePath = fileURLToPath(
  new URL("../../../docs/superpowers/spike-findings/fixtures/opencode-tools.json", import.meta.url));
const hostTools = JSON.parse(readFileSync(fixturePath, "utf8")) as WireTool[];

describe("seedRegistry", () => {
  it("registers every host tool from the fixture", () => {
    const registry = createToolRegistry();
    expect(seedRegistry(registry, hostTools, createOpenCodeDialect())).toBe(10);
    for (const t of hostTools) expect(registry.lookup(t.function.name)).toBeDefined();
  });
  it("is idempotent: a second seed adds nothing and does not throw", () => {
    const registry = createToolRegistry();
    seedRegistry(registry, hostTools, createOpenCodeDialect());
    expect(seedRegistry(registry, hostTools, createOpenCodeDialect())).toBe(0);
  });
  it("treats an absent tools array as nothing to seed", () => {
    const registry = createToolRegistry();
    expect(seedRegistry(registry, undefined, createIdentityDialect())).toBe(0);
  });
});

describe("canonicalizeCalls", () => {
  it("rewrites host calls into the canonical vocabulary for guidance/stall detection", () => {
    const [call] = canonicalizeCalls(createOpenCodeDialect(), [{
      id: "call_1", type: "function",
      function: { name: "edit",
        arguments: "{\"filePath\":\"/w/task/a.txt\",\"oldString\":\"wrld\",\"newString\":\"x\"}" },
    }]);
    expect(call.function.name).toBe("edit");
    expect(JSON.parse(call.function.arguments))
      .toEqual({ path: "/w/task/a.txt", oldText: "wrld", newText: "x" });
  });
  it("survives unparseable arguments", () => {
    const [call] = canonicalizeCalls(createOpenCodeDialect(), [{
      id: "call_2", type: "function", function: { name: "read", arguments: "{oops" },
    }]);
    expect(JSON.parse(call.function.arguments)).toEqual({});
  });
});
