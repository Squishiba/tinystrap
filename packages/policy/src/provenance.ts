export type ScanVerdict = "clean" | "dangerous";
export type ExecCheck = "run" | "rescan" | "redecide";

export class ScriptLedger {
  private entries = new Map<string, { hash: string; verdict: ScanVerdict }>();

  recordWrite(path: string, hash: string, verdict: ScanVerdict): void {
    this.entries.set(path, { hash, verdict });
  }

  checkExec(path: string, hash: string): ExecCheck {
    const e = this.entries.get(path);
    if (!e) return "rescan";
    if (e.hash !== hash) return "rescan";
    return e.verdict === "clean" ? "run" : "redecide";
  }
}
