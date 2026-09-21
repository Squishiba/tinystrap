import { describe, expect, it } from "vitest";
import { NoteStore } from "@tinystrap/proxy";

describe("pinned notes", () => {
  it("enforces the cap and the per-note length", () => {
    const n = new NoteStore({ cap: 2, maxChars: 10 });
    n.set("plan", "do x");
    n.set("fact", "y is z");
    expect(() => n.set("third", "nope")).toThrow(/cap/);
    expect(() => n.set("long", "x".repeat(11))).toThrow(/length/);
  });
  it("renders a pinned block and survives overwrite", () => {
    const n = new NoteStore();
    n.set("decision", "use pnpm");
    n.set("decision", "use pnpm workspaces");
    expect(n.renderPinned()).toContain("decision: use pnpm workspaces");
    n.remove("decision");
    expect(n.renderPinned()).toBe("");
  });
});
