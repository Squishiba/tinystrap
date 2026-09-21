import { describe, expect, it } from "vitest";
import { analyzeShell, effectSignature, effectsFromFile, effectsFromShell } from "@tinystrap/policy";

const WS = "/task/ws";

describe("effect classifier", () => {
  it("classifies file tools", () => {
    expect(effectsFromFile("edit", "src/a.ts", WS))
      .toEqual([{ target: "/task/ws/src/a.ts", kind: "write", scope: "in_workspace" }]);
    expect(effectsFromFile("read", "../../etc/passwd", WS)[0].scope)
      .toBe("out_of_workspace");
  });
  it("one rule covers every write route", () => {
    const routes = [
      "echo x > out.txt",
      "tee out.txt",
      "cp a out.txt",
      "sed -i s/a/b/ out.txt",
    ];
    for (const cmd of routes) {
      const a = analyzeShell(cmd);
      expect(a.ok, cmd).toBe(true);
      if (!a.ok) continue;
      const writes = effectsFromShell(a, WS, WS).filter((e) => e.kind === "write");
      expect(writes.map((e) => e.target), cmd).toContain("/task/ws/out.txt");
    }
  });
  it("classifies git and network", () => {
    const a = analyzeShell("git push origin main") as { ok: true; statements: unknown[] };
    const eff = effectsFromShell(a, WS, WS);
    expect(eff.some((e) => e.kind === "git" && e.target === "push")).toBe(true);
    const c = analyzeShell("curl https://example.com/x");
    if (c.ok) expect(effectsFromShell(c, WS, WS).some((e) => e.kind === "network")).toBe(true);
  });
  it("signature is order-insensitive", () => {
    const s1 = effectSignature([
      { target: "b", kind: "write", scope: "in_workspace" },
      { target: "a", kind: "read", scope: "in_workspace" },
    ]);
    const s2 = effectSignature([
      { target: "a", kind: "read", scope: "in_workspace" },
      { target: "b", kind: "write", scope: "in_workspace" },
    ]);
    expect(s1).toBe(s2);
  });
});
