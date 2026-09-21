import { execFile } from "node:child_process";

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

export function parsePythonAst(source: string): Promise<unknown | null> {
  return new Promise((resolve) => {
    const child = execFile("python", ["-c", DRIVER], { maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => {
        if (err) { resolve(null); return; }
        try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
      });
    child.stdin?.write(source);
    child.stdin?.end();
  });
}
