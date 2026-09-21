export class NoteStore {
  private notes = new Map<string, string>();
  private readonly cap: number;
  private readonly maxChars: number;

  constructor(opts: { cap?: number; maxChars?: number } = {}) {
    this.cap = opts.cap ?? 5;
    this.maxChars = opts.maxChars ?? 200;
  }

  set(key: string, note: string): void {
    if (note.length > this.maxChars) {
      throw new Error(`note over length limit (${this.maxChars} chars)`);
    }
    if (!this.notes.has(key) && this.notes.size >= this.cap) {
      throw new Error(`note cap reached (${this.cap})`);
    }
    this.notes.set(key, note);
  }

  remove(key: string): void { this.notes.delete(key); }

  renderPinned(): string {
    if (this.notes.size === 0) return "";
    const lines = [...this.notes.entries()].map(([k, v]) => `${k}: ${v}`);
    return `--- pinned notes (harness) ---\n${lines.join("\n")}\n--- end pinned notes ---`;
  }
}
