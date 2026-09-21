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
    const d = mk({ midStreamClose: true, scoreThreshold: 0.2 });
    let action: string = "none";
    for (let i = 0; i < 30; i++) {
      action = d.push(`thinking about thing ${i % 3} again and again and again more`);
    }
    expect(action).toBe("close_reasoning");
    const d2 = mk({ scoreThreshold: 0.2 });
    let action2: string = "none";
    for (let i = 0; i < 30; i++) {
      action2 = d2.push(`thinking about thing ${i % 3} again and again and again more`);
    }
    expect(action2).not.toBe("close_reasoning");
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
});
