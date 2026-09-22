import { NoteStore } from "./notes.js";
import type { ChatMessage } from "./types.js";

export const PINNED_SENTINEL = "--- pinned notes (harness) ---";
export type PinOutcome = { applied: boolean; message: string };

export function applyPinNote(store: NoteStore, args: Record<string, unknown>): PinOutcome {
  const key = typeof args.key === "string" ? args.key : "";
  if (key === "") return { applied: false, message: "pin_note: missing key" };
  try {
    if (args.remove === true) { store.remove(key); return { applied: true, message: `unpinned ${key}` }; }
    if (typeof args.note !== "string") return { applied: false, message: "pin_note: note must be a string" };
    store.set(key, args.note);
    return { applied: true, message: `pinned ${key}` };
  } catch (err) {
    return { applied: false, message: `pin_note rejected: ${(err as Error).message}` };
  }
}

export function withPinnedNotes(messages: ChatMessage[], pinned: string): ChatMessage[] {
  const kept = messages.filter((m) =>
    !(m.role === "system" && typeof m.content === "string" && m.content.startsWith(PINNED_SENTINEL)));
  if (pinned === "") return kept;
  const at = kept.length > 0 && kept[0].role === "system" ? 1 : 0;
  return [...kept.slice(0, at), { role: "system" as const, content: pinned }, ...kept.slice(at)];
}