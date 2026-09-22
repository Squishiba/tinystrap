import { describe, expect, it } from "vitest";
import { NoteStore, applyPinNote, withPinnedNotes, PINNED_SENTINEL } from "@tinystrap/proxy";
import type { ChatMessage } from "@tinystrap/proxy";

describe("applyPinNote", () => {
  it("sets, overwrites, and removes through the capped store", () => {
    const s = new NoteStore({ cap: 1, maxChars: 10 });
    expect(applyPinNote(s, { key: "plan", note: "do x" })).toEqual({ applied: true, message: "pinned plan" });
    expect(applyPinNote(s, { key: "other", note: "nope" }).applied).toBe(false); // cap
    expect(applyPinNote(s, { key: "plan", remove: true })).toEqual({ applied: true, message: "unpinned plan" });
    expect(applyPinNote(s, { note: "no key" }).applied).toBe(false);
    expect(applyPinNote(s, { key: "k" }).applied).toBe(false); // no note, no remove
  });
});

describe("withPinnedNotes", () => {
  const msgs: ChatMessage[] = [
    { role: "system", content: "you are a coder" },
    { role: "user", content: "hi" },
  ];
  it("inserts the pinned block after the leading system message", () => {
    const out = withPinnedNotes(msgs, `${PINNED_SENTINEL}\nplan: do x\n--- end pinned notes ---`);
    expect(out).toHaveLength(3);
    expect(out[1].role).toBe("system");
    expect(out[1].content).toContain("plan: do x");
  });
  it("replaces rather than duplicates an existing pinned block", () => {
    const once = withPinnedNotes(msgs, `${PINNED_SENTINEL}\nplan: a\n--- end pinned notes ---`);
    const twice = withPinnedNotes(once, `${PINNED_SENTINEL}\nplan: b\n--- end pinned notes ---`);
    expect(twice.filter((m) => m.content?.startsWith(PINNED_SENTINEL))).toHaveLength(1);
    expect(twice[1].content).toContain("plan: b");
  });
  it("empty pinned text strips any existing block", () => {
    const once = withPinnedNotes(msgs, `${PINNED_SENTINEL}\nplan: a\n--- end pinned notes ---`);
    expect(withPinnedNotes(once, "")).toEqual(msgs);
  });
});