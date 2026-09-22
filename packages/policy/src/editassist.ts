export type LineSpan = { startLine: number; endLine: number };

// Whitespace-insensitive: compare the word-token sequence of each line so
// operator spacing ("a + b" vs "a+b") and punctuation do not break a match.
function normLine(s: string): string { return (s.match(/[A-Za-z0-9_]+/g) ?? []).join(" "); }

export function sliceAround(content: string, line: number, radius: number):
  { startLine: number; endLine: number; text: string } {
  const lines = content.split(/\r?\n/);
  const startLine = Math.max(0, line - radius);
  const endLine = Math.min(lines.length - 1, line + radius);
  return { startLine, endLine, text: lines.slice(startLine, endLine + 1).join("\n") };
}

export function findNormalizedMatches(content: string, oldText: string): LineSpan[] {
  const norm = content.split(/\r?\n/).map(normLine);
  const want = oldText.split(/\r?\n/).map(normLine).filter((l) => l !== "");
  if (want.length === 0) return [];
  const idx: number[] = [];
  norm.forEach((l, i) => { if (l !== "") idx.push(i); });
  const spans: LineSpan[] = [];
  for (let s = 0; s + want.length <= idx.length; s++) {
    let ok = true;
    for (let k = 0; k < want.length; k++) {
      if (norm[idx[s + k]] !== want[k]) { ok = false; break; }
    }
    if (ok) spans.push({ startLine: idx[s], endLine: idx[s + want.length - 1] });
  }
  return spans;
}

export function extractSpan(content: string, span: LineSpan): string {
  return content.split(/\r?\n/).slice(span.startLine, span.endLine + 1).join("\n");
}

export function closestLines(content: string, oldText: string, max = 5):
  { line: number; text: string }[] {
  const target = new Set(normLine(oldText.split(/\r?\n/)[0] ?? "").split(" ").filter(Boolean));
  if (target.size === 0) return [];
  return content.split(/\r?\n/)
    .map((text, line) => {
      const toks = normLine(text).split(" ").filter(Boolean);
      const score = toks.length === 0 ? 0
        : toks.filter((t) => target.has(t)).length / toks.length;
      return { line, text, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map(({ line, text }) => ({ line, text }));
}