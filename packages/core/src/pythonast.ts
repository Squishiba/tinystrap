import { execFile } from "node:child_process";
import { PYTHON_CANDIDATES } from "./syntax.js";

const DRIVER = `
import ast, json, sys

def flat(node):
    if isinstance(node, ast.Constant):
        v = node.value
        return v if isinstance(v, (str, int, float, bool)) or v is None else str(v)
    if isinstance(node, ast.AST):
        d = {"nodeType": type(node).__name__}
        for field, value in ast.iter_fields(node):
            d[field] = flat(value)
        for attr in ("lineno",):
            if hasattr(node, attr):
                d[attr] = getattr(node, attr)
        return d
    if isinstance(node, list):
        return [flat(v) for v in node]
    if isinstance(node, (str, int, float, bool)) or node is None:
        return node
    return str(node)

def dotted(func):
    parts = []
    while isinstance(func, ast.Attribute):
        parts.append(func.attr); func = func.value
    if isinstance(func, ast.Name):
        parts.append(func.id)
    return ".".join(reversed(parts))

try:
    tree = ast.parse(sys.stdin.read())
except SyntaxError:
    sys.exit(1)

for n in ast.walk(tree):
    if isinstance(n, ast.Call):
        n.func = dotted(n.func)

print(json.dumps(flat(tree)))
`;

// Same `python`-vs-`python3` problem as syntax.ts's checkPython, and the same
// fix: try each candidate in turn, but only ever retry on ENOENT (a missing
// binary) — a real parse failure (SyntaxError, exit 1) resolves null on the
// first candidate that runs, same as before this fix.
export function parsePythonAst(
  source: string,
  candidates: readonly string[] = PYTHON_CANDIDATES,
): Promise<unknown | null> {
  const [bin, ...rest] = candidates;
  if (bin === undefined) return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = execFile(bin, ["-c", DRIVER], { maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => {
        if (!err) {
          try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
          return;
        }
        if ((err as NodeJS.ErrnoException).code === "ENOENT" && rest.length > 0) {
          resolve(parsePythonAst(source, rest));
          return;
        }
        resolve(null);
      });
    child.stdin?.write(source);
    child.stdin?.end();
  });
}
