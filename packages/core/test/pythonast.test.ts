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
  });
  it("returns null on invalid python", async () => {
    expect(await parsePythonAst("def (")).toBeNull();
  });
});
