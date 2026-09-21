export type PythonFinding = { name: string; line?: number };
export type PythonAnalysis = { dangerous: PythonFinding[]; unparseable: boolean };

const BLOCKLIST = [
  /^os\.system$/, /^subprocess\./, /^socket\./, /^urllib\./,
  /^shutil\./, /^ctypes\./, /^__import__$/, /^importlib\./,
  /^exec$/, /^eval$/,
];

function isDangerousCall(node: Record<string, unknown>): boolean {
  const func = node.func;
  if (typeof func !== "string") return false;
  if (BLOCKLIST.some((re) => re.test(func))) return true;
  if (func === "open") {
    const args = Array.isArray(node.args) ? node.args : [];
    const mode = args[1] ?? (node.keywords as Record<string, unknown> | undefined)?.mode;
    return typeof mode === "string" && /[wax+]/.test(mode);
  }
  return false;
}

export function analyzePythonAst(ast: unknown): PythonAnalysis {
  if (typeof ast !== "object" || ast === null) return { dangerous: [], unparseable: true };
  const dangerous: PythonFinding[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node !== "object" || node === null) return;
    const rec = node as Record<string, unknown>;
    if (rec.nodeType === "Call" && isDangerousCall(rec)) {
      dangerous.push({
        name: String(rec.func),
        line: typeof rec.lineno === "number" ? rec.lineno : undefined,
      });
    }
    for (const v of Object.values(rec)) walk(v);
  };
  walk(ast);
  return { dangerous, unparseable: false };
}
