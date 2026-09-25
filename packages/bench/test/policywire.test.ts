import { describe, expect, it } from "vitest";
import { makeBenchRegistry, makePreflight } from "@tinystrap/bench";
import type { Preflight } from "@tinystrap/proxy";

// A fake workspace root: the gate is pure path logic, no fs access needed.
const WS = "/work/ws";

function wire(exists: (p: string) => boolean = () => true): Preflight {
  const registry = makeBenchRegistry();
  return makePreflight({
    workspaceRoot: WS, registry, taskId: "t1", phase: "implementation", exists,
  });
}

describe("makePreflight read-before-edit bookkeeping", () => {
  it("denies an edit before the file was read, allows it after a successful read", () => {
    const pf = wire();
    expect(pf("edit", { path: "src/a.ts", oldText: "x", newText: "y" }).effect).toBe("deny");
    expect(pf("read", { path: "src/a.ts" }).effect).toBe("allow");
    // Regression: readSet was never populated, so this stayed denied forever
    // and EVERY coding task failed regardless of the model.
    expect(pf("edit", { path: "src/a.ts", oldText: "x", newText: "y" }).effect).toBe("allow");
  });

  it("relative and absolute spellings of the same path share one readSet entry", () => {
    const pf = wire();
    expect(pf("read", { path: "a/b.py" }).effect).toBe("allow");
    expect(pf("edit", { path: `${WS}/a/b.py`, oldText: "x", newText: "y" }).effect).toBe("allow");
  });

  it("does not record denied reads", () => {
    const pf = wire();
    expect(pf("read", { path: "/etc/passwd" }).effect).toBe("deny");
    expect(pf("edit", { path: "/etc/passwd", oldText: "x", newText: "y" }).effect).toBe("deny");
  });

  it("grep counts as a read when the host provides it (READ_TOOLS vocabulary of effects.ts)", () => {
    const registry = makeBenchRegistry();
    // Hosts like OpenCode ship grep; the proxy seeds it per request. The
    // bench registry itself does not carry it, so register it here.
    registry.register({ name: "grep", description: "grep", inputSchema: {}, capabilities: [], readOnly: true });
    const pf = makePreflight({
      workspaceRoot: WS, registry, taskId: "t1", phase: "implementation", exists: () => true,
    });
    expect(pf("grep", { path: "notes.md" }).effect).toBe("allow");
    expect(pf("edit", { path: "notes.md", oldText: "x", newText: "y" }).effect).toBe("allow");
  });
});
