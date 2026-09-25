import { describe, expect, it } from "vitest";
import { parsePythonAst } from "@tinystrap/core";
import { analyzePythonAst } from "@tinystrap/policy";

describe("python ast producer", () => {
  it("produces AST JSON the policy analyzer understands", async () => {
    const ast = await parsePythonAst("import os\nos.system('ls')\nopen('f', 'w')\n");
    if (ast === null) return; // python not installed on this machine: skip (recorded in CI notes)
    const a = analyzePythonAst(ast);
    expect(a.unparseable).toBe(false);
    expect(a.dangerous.map((d) => d.name).sort()).toEqual(["open", "os.system"]);
    // python subprocess startup is slow on loaded Windows runners; 20_000
    // keeps the per-test deadline far above the measured 5 s CI spikes.
  }, 20_000);
  it("returns null on invalid python", async () => {
    expect(await parsePythonAst("def (")).toBeNull();
  }, 20_000);
});
