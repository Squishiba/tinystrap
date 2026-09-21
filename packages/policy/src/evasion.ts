import { effectSignature } from "./effects.js";
import type { EffectRecord } from "./types.js";

export type Escalation = "strip_tool" | "inject_correction" | "stop";

export class EvasionTracker {
  private denied = new Map<string, number>();

  recordDenial(effects: EffectRecord[]): string {
    const sig = effectSignature(effects);
    this.denied.set(sig, (this.denied.get(sig) ?? 0) + 1);
    return sig;
  }

  check(effects: EffectRecord[]): { flagged: boolean; count: number } {
    const sig = effectSignature(effects);
    const current = this.denied.get(sig);
    if (current === undefined) return { flagged: false, count: 0 };
    this.denied.set(sig, current + 1);
    return { flagged: true, count: current };
  }

  escalate(count: number): Escalation {
    if (count <= 1) return "strip_tool";
    if (count === 2) return "inject_correction";
    return "stop";
  }
}
