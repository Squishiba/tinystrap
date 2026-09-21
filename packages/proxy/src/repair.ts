import type { ToolRegistry } from "@tinystrap/policy";
import type { ToolCall } from "./types.js";

export type RepairOptions = {
  maxNameDistance?: number;
  aliases?: Record<string, Record<string, string>>;
};
export type RepairOutcome = { calls: ToolCall[]; repairs: string[] };

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]; prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

// "read_file" is 5 edits from "read" — beyond any sane edit distance — but a
// whole-token name match is the classic small-model habit, so accept it too.
function nameMatches(called: string, toolName: string, maxDistance: number): boolean {
  if (called.split(/[_\-\s]+/).includes(toolName)) return true;
  return levenshtein(called, toolName) <= maxDistance;
}

function closeTruncatedJson(s: string): string | null {
  let depth = 0; let inStr = false; let esc = false;
  for (const c of s) {
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{") depth++;
    if (c === "}") depth--;
  }
  if (depth <= 0) return null;
  const candidate = s + "}".repeat(depth);
  try { JSON.parse(candidate); return candidate; } catch { return null; }
}

export function repairToolCalls(
  calls: ToolCall[], registry: ToolRegistry, opts: RepairOptions = {},
): RepairOutcome {
  const maxDistance = opts.maxNameDistance ?? 2;
  const repairs: string[] = [];
  const fixed = calls.map((c) => {
    let name = c.function.name;
    let args = c.function.arguments;
    if (!registry.lookup(name)) {
      const near = registry.all()
        .map((t) => ({ t, d: levenshtein(name, t.name) }))
        .filter((x) => x.d > 0 && nameMatches(name, x.t.name, maxDistance))
        .sort((x, y) => x.d - y.d)[0];
      if (near) { repairs.push(`name:${name}->${near.t.name}`); name = near.t.name; }
    }
    const alias = opts.aliases?.[name];
    if (alias) {
      for (const [wrong, right] of Object.entries(alias)) {
        const needle = `"${wrong}"`;
        if (args.includes(needle)) {
          args = args.split(needle).join(`"${right}"`);
          repairs.push(`arg:${wrong}->${right}`);
        }
      }
    }
    try { JSON.parse(args); }
    catch {
      const closed = closeTruncatedJson(args);
      if (closed !== null) { args = closed; repairs.push("json:closed"); }
    }
    return { ...c, function: { name, arguments: args } };
  });
  return { calls: fixed, repairs };
}
