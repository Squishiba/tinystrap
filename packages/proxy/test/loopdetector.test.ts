import { describe, expect, it } from "vitest";
import { LoopDetector } from "@tinystrap/proxy";

const mk = (over: Partial<ConstructorParameters<typeof LoopDetector>[0]> = {}) =>
  new LoopDetector({
    taskId: "t1", scoreThreshold: 0.5, backstopTokens: 100000,
    midStreamClose: false, ...over,
  });

describe("loop detector", () => {
  it("verbatim repetition is decisive -> nudge", () => {
    const d = mk();
    const s = "I should check the file first to understand the layout.";
    d.push(s); d.push(" ");
    const a = d.push(s);
    expect(a).toBe("nudge");
    expect(d.signals().verbatim).toBe(true);
  });
  it("close_reasoning only when midStreamClose capability is on", () => {
    // Ladder-aware form of the original: after maxNudges the escalation rung is
    // close_reasoning only with the capability on; without it the rung is the
    // backstop and close_reasoning never appears.
    const over = { scoreThreshold: 0.2, nudgeCooldownChars: 0, maxNudges: 2 };
    const d = mk({ midStreamClose: true, ...over });
    let action: string = "none";
    for (let i = 0; i < 30; i++) {
      action = d.push(`thinking about thing ${i % 3} again and again and again more`);
    }
    expect(action).toBe("close_reasoning");
    const d2 = mk(over);
    let action2: string = "none";
    for (let i = 0; i < 30; i++) {
      action2 = d2.push(`thinking about thing ${i % 3} again and again and again more`);
    }
    expect(action2).not.toBe("close_reasoning");
    expect(action2).toBe("backstop");
  });
  it("backstop fires on absolute token cap regardless of score", () => {
    const d = mk({ backstopTokens: 10 });
    expect(d.push("word ".repeat(100))).toBe("backstop");
  });
  it("progressing thinking stays at none", () => {
    const d = mk();
    for (let i = 0; i < 30; i++) expect(d.push(`unique sentence number ${i} about ${i * i}`)).toBe("none");
  });
  it("interventions are reported with signal values", () => {
    const seen: string[] = [];
    const d = new LoopDetector({
      taskId: "t1", scoreThreshold: 0.5, backstopTokens: 5, midStreamClose: false,
      onIntervention: (a) => seen.push(a),
    });
    d.push("word ".repeat(100));
    expect(seen).toEqual(["backstop"]);
  });

  it("500 identical deltas nudge at most maxNudges times and reach the escalation rung", () => {
    const d = mk();
    const delta = "loop same loop same!";
    const counts: Partial<Record<string, number>> = {};
    for (let i = 0; i < 500; i++) {
      const a = d.push(delta);
      counts[a] = (counts[a] ?? 0) + 1;
    }
    expect(counts.nudge ?? 0).toBeGreaterThan(0);
    expect(counts.nudge ?? 0).toBeLessThanOrEqual(3);
    expect(counts.close_reasoning ?? 0).toBe(0);
    expect(counts.backstop ?? 0).toBeGreaterThan(0);
  });

  it("cooldown suppresses re-nudging until nudgeCooldownChars elapse, then re-nudges up to maxNudges", () => {
    const d = mk({ nudgeCooldownChars: 100, maxNudges: 2 });
    const s = "I should check the file first to understand the layout.";
    expect(d.push(s)).toBe("none");
    expect(d.push(s)).toBe("nudge");
    expect(d.push(s)).toBe("none");   // 56 chars since the nudge: still cooling down
    expect(d.push(s)).toBe("nudge");  // 112 chars: cooldown elapsed, trip again
    expect(d.push(s)).toBe("none");
    expect(d.push(s)).toBe("backstop"); // maxNudges reached -> next rung (no midStreamClose)
  });

  it("escalates to close_reasoning after maxNudges when midStreamClose is on", () => {
    const d = mk({ midStreamClose: true, nudgeCooldownChars: 0, maxNudges: 2 });
    const s = "I should check the file first to understand the layout.";
    const acts: string[] = [];
    for (let i = 0; i < 10; i++) acts.push(d.push(s));
    expect(acts.filter((a) => a === "nudge").length).toBe(2);
    expect(acts.filter((a) => a === "close_reasoning").length).toBeGreaterThan(0);
  });

  it("novel reasoning of thousands of characters never nudges", () => {
    const d = mk();
    let total = 0;
    for (let i = 0; i < 300; i++) {
      const delta = `unique sentence number ${i} about ${i * i} with detail ${i * 7 + 3}. `;
      total += delta.length;
      expect(d.push(delta)).toBe("none");
    }
    expect(total).toBeGreaterThan(2000);
  });

  it("intervention detail carries the nudge index", () => {
    const seen: string[] = [];
    const d = new LoopDetector({
      taskId: "t1", scoreThreshold: 0.5, backstopTokens: 100000, midStreamClose: false,
      nudgeCooldownChars: 0,
      onIntervention: (a, _s, detail) => seen.push(detail ?? a),
    });
    const s = "I should check the file first to understand the layout.";
    for (let i = 0; i < 5; i++) d.push(s);
    expect(seen).toEqual(["nudge 1/3", "nudge 2/3", "nudge 3/3", "backstop after 3 nudges"]);
  });

  it("endTurn resets the nudge count and cooldown", () => {
    const d = mk({ nudgeCooldownChars: 0, maxNudges: 1 });
    const s = "I should check the file first to understand the layout.";
    d.push(s); d.push(s); d.push(s);
    d.endTurn();
    expect(d.push(s)).toBe("nudge");
  });
});
