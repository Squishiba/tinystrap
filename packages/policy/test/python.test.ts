import { describe, expect, it } from "vitest";
import { analyzePythonAst } from "@tinystrap/policy";

const call = (func: string, args: unknown[] = [], lineno = 1) =>
  ({ nodeType: "Call", func, args, lineno });
const mod = (...body: unknown[]) => ({ nodeType: "Module", body });

describe("python analyzer", () => {
  it("flags blocklisted calls", () => {
    const a = analyzePythonAst(mod(
      call("os.system", ["rm -rf /"]),
      call("subprocess.run", ["ls"]),
      call("__import__", ["socket"]),
    ));
    expect(a.unparseable).toBe(false);
    expect(a.dangerous.map((d) => d.name).sort())
      .toEqual(["__import__", "os.system", "subprocess.run"]);
  });
  it("flags write-mode open only", () => {
    expect(analyzePythonAst(mod(call("open", ["f.txt", "w"]))).dangerous.length).toBe(1);
    expect(analyzePythonAst(mod(call("open", ["f.txt", "r"]))).dangerous.length).toBe(0);
  });
  it("finds nested calls inside expressions", () => {
    const tree = mod({ nodeType: "Expr", value: call("eval", ["x"]) });
    expect(analyzePythonAst(tree).dangerous[0].name).toBe("eval");
  });
  it("null ast is unparseable", () => {
    expect(analyzePythonAst(null)).toEqual({ dangerous: [], unparseable: true });
  });
});
