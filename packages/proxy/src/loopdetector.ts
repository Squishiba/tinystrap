export type LoopSignals = {
  repetition: number; repeatedConclusion: number; noveltyDecline: number;
  noCommitment: number; crossTurn: number; verbatim: boolean;
};
export type LoopAction = "none" | "nudge" | "close_reasoning" | "backstop";

const CONCLUSION = /^(therefore|so |thus|in conclusion)/i;
const COMMITMENT = /let me|first|i will|i'll|action/i;

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function sentences(buf: string): string[] {
  return buf.split(/[.!?]+/).map(normalize).filter((s) => s.length > 0);
}

// Near-duplicate test: fraction of a's tokens present in b (either direction ≥ 0.8).
function tokenOverlap(a: string, b: string): number {
  const ta = a.split(" ").filter(Boolean);
  const tb = new Set(b.split(" ").filter(Boolean));
  if (ta.length === 0 || tb.size === 0) return 0;
  return ta.filter((t) => tb.has(t)).length / ta.length;
}

function nearDuplicate(a: string, b: string): boolean {
  return tokenOverlap(a, b) >= 0.8 || tokenOverlap(b, a) >= 0.8;
}

type Unit = { text: string; dup: boolean };

export class LoopDetector {
  private buf = "";
  private totalChars = 0;
  private units: Unit[] = [];
  private seen = new Set<string>();
  private seenSentences = new Set<string>();
  private prevTurn = new Set<string>();
  private current = new Set<string>();
  private last: LoopSignals = {
    repetition: 0, repeatedConclusion: 0, noveltyDecline: 0,
    noCommitment: 0, crossTurn: 0, verbatim: false,
  };

  constructor(private readonly opts: {
    taskId: string; scoreThreshold: number; backstopTokens: number;
    midStreamClose: boolean;
    onIntervention?: (action: LoopAction, signals: LoopSignals) => void;
  }) {}

  signals(): LoopSignals { return this.last; }

  endTurn(): void {
    this.prevTurn = new Set([...this.prevTurn, ...this.current]);
    this.current = new Set();
    this.units = [];
    this.buf = "";
  }

  push(delta: string): LoopAction {
    this.buf += delta;
    this.totalChars += delta.length;

    const unit = normalize(delta);
    let verbatim = this.last.verbatim;
    if (unit !== "") {
      const exact = this.seen.has(unit);
      if (exact) verbatim = true;
      const dup = exact || this.units.some((u) => nearDuplicate(u.text, unit));
      this.seen.add(unit);
      this.current.add(unit);
      this.units.push({ text: unit, dup });
      if (this.units.length > 20) this.units.shift();
    }

    const sents = sentences(this.buf);
    const repeatedConclusion = sents.filter((s) =>
      CONCLUSION.test(s) && this.seenSentences.has(s)).length;
    for (const s of sents) this.seenSentences.add(s);

    const window = this.units.length;
    const repetition = window > 0 ? this.units.filter((u) => u.dup).length / window : 0;
    const distinct = new Set(this.units.map((u) => u.text)).size;
    const noveltyDecline = window > 0 ? 1 - distinct / window : 0;
    const crossTurn = window > 0
      ? this.units.filter((u) => this.prevTurn.has(u.text)).length / window : 0;
    const noCommitment = sents.length > 40 && !sents.slice(20).some((s) => COMMITMENT.test(s))
      ? 1 : 0;

    const signals: LoopSignals = {
      repetition, repeatedConclusion, noveltyDecline, noCommitment, crossTurn, verbatim,
    };
    this.last = signals;

    if (this.totalChars / 4 >= this.opts.backstopTokens) return this.fire("backstop", signals);

    const score = Math.min(1, Math.max(repetition, noveltyDecline, crossTurn) +
      0.1 * (repeatedConclusion > 0 ? 1 : 0) + 0.1 * noCommitment);
    if (score >= this.opts.scoreThreshold) {
      if (this.opts.midStreamClose) return this.fire("close_reasoning", signals);
      return this.fire("nudge", signals);
    }
    if (verbatim) return this.fire("nudge", signals);
    return "none";
  }

  private fire(action: LoopAction, signals: LoopSignals): LoopAction {
    this.opts.onIntervention?.(action, signals);
    return action;
  }
}
