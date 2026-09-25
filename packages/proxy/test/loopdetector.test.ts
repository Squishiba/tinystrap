import { describe, expect, it } from "vitest";
import { LoopDetector } from "@tinystrap/proxy";

const mk = (over: Partial<ConstructorParameters<typeof LoopDetector>[0]> = {}) =>
  new LoopDetector({
    taskId: "t1", scoreThreshold: 0.5, backstopTokens: 100000,
    midStreamClose: false, ...over,
  });

describe("loop detector", () => {
  it("verbatim repetition is decisive -> nudge", () => {
    // Threshold high enough that the score alone could not fire: the nudge
    // comes from verbatim units alone, once a unit has repeated verbatimRepeats
    // (default 3) times in the turn. Two occurrences are not enough.
    const d = mk({ scoreThreshold: 0.95 });
    const s = "I should check the file first to understand the layout.";
    expect(d.push(s)).toBe("none");
    expect(d.push(s)).toBe("none");
    expect(d.push(s)).toBe("nudge");
    expect(d.signals().verbatim).toBe(true);
  });
  it("verbatim is window-scoped and clears once the repeat leaves the window", () => {
    const d = mk({ scoreThreshold: 0.95 });
    const s = "I should check the file first to understand the layout.";
    d.push(s); d.push(s); d.push(s);
    expect(d.signals().verbatim).toBe(true);
    for (let i = 0; i < 25; i++) {
      expect(d.push(`fresh observation number ${i} with distinct content ${i * 3}.`)).toBe("none");
    }
    expect(d.signals().verbatim).toBe(false);
  });
  it("short repeated fragments below minUnitChars never form units", () => {
    const d = mk({ scoreThreshold: 0.5 });
    for (let i = 0; i < 50; i++) expect(d.push("yes.")).toBe("none");
    expect(d.signals().verbatim).toBe(false);
  });
  it("verbatimRepeats is configurable", () => {
    const d = mk({ scoreThreshold: 0.95, verbatimRepeats: 2 });
    const s = "Close the loop on this one single repeated sentence.";
    expect(d.push(s)).toBe("none");
    expect(d.push(s)).toBe("nudge");
  });
  it("token-level deltas of a non-looping passage never nudge", () => {
    // Real reasoning streams arrive as sub-word deltas; common short tokens
    // repeat constantly and must not be treated as verbatim units.
    const d = mk({ scoreThreshold: 0.7 });
    const passage = [
      "The configuration file describes three services that start in sequence during boot.",
      "Each service waits for the previous one to report readiness before its own startup hook runs.",
      "If a hook fails, the supervisor logs the failure and retries after a short backoff window.",
      "Operators usually inspect the log bundle first, because it shows the exact ordering that the scheduler chose on that particular machine.",
      "A second pass over the bundle revealed an unexpected clock skew between two hosts in the rack.",
      "The skew was small, only a few hundred milliseconds, but it was enough to reorder the readiness events in the merged timeline.",
      "Nobody had noticed earlier because the health dashboard only samples once per minute and rounds every timestamp down to the nearest second.",
      "The fix landed as a change to the supervisor rather than to the services themselves.",
      "Now the supervisor stamps each event with a monotonic counter, and the merger prefers the counter over the wall clock whenever both are present.",
      "The change is backwards compatible: older agents that do not send counters still work, they simply fall back to the noisier clock based ordering used by the previous release.",
      "After deployment the team watched the dashboard for a full day.",
      "The merged timelines looked sane on every sample they pulled, and the retry storms that had plagued the staging environment stopped appearing entirely.",
      "They decided to keep the counter approach permanently and to revisit the sampling interval in a later iteration, once the on-call rotation had spare capacity to design a proper experiment.",
    ].join(" ");
    expect(passage.length).toBeGreaterThanOrEqual(1500);
    const sizes = [1, 2, 3, 4, 5];
    let i = 0; let n = 0;
    while (i < passage.length) {
      const size = sizes[n % sizes.length];
      expect(d.push(passage.slice(i, i + size))).toBe("none");
      i += size; n += 1;
    }
    expect(d.signals().verbatim).toBe(false);
  });
  it("a genuinely looping token-delta stream still nudges and escalates", () => {
    const d = mk({ scoreThreshold: 0.7, nudgeCooldownChars: 0 });
    const sentence = "I should read the file again just to be sure.";
    expect(sentence.length).toBeGreaterThanOrEqual(40);
    const counts: Partial<Record<string, number>> = {};
    for (let r = 0; r < 30; r++) {
      for (let i = 0; i < sentence.length; i += 4) {
        const a = d.push(sentence.slice(i, i + 4));
        counts[a] = (counts[a] ?? 0) + 1;
      }
    }
    expect(counts.nudge ?? 0).toBe(3);
    expect(counts.backstop ?? 0).toBeGreaterThan(0);
    expect(counts.close_reasoning ?? 0).toBe(0);
  });
  it("close_reasoning only when midStreamClose capability is on", () => {
    // Ladder-aware form of the original: after maxNudges the escalation rung is
    // close_reasoning only with the capability on; without it the rung is the
    // backstop and close_reasoning never appears.
    const over = { scoreThreshold: 0.2, nudgeCooldownChars: 0, maxNudges: 2 };
    const d = mk({ midStreamClose: true, ...over });
    let action: string = "none";
    for (let i = 0; i < 30; i++) {
      action = d.push(`thinking about thing ${i % 3} again and again and again more.`);
    }
    expect(action).toBe("close_reasoning");
    const d2 = mk(over);
    let action2: string = "none";
    for (let i = 0; i < 30; i++) {
      action2 = d2.push(`thinking about thing ${i % 3} again and again and again more.`);
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
    const delta = "loop the same loop over and over again!";
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
