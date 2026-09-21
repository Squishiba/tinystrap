export type ShellRedirect = { target: string; mode: "write" | "append" };
export type ShellStatement = {
  program: string;
  args: string[];
  redirects: ShellRedirect[];
};
export type ShellAnalysis =
  | { ok: true; statements: ShellStatement[] }
  | { ok: false; reason: "unparseable" | "obfuscated" };

const FAIL: ShellAnalysis = { ok: false, reason: "obfuscated" };

function splitStatements(command: string): string[] | null {
  const parts: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    if (c === "\\" && i + 1 < command.length) { cur += c + command[++i]; continue; }
    if (c === "|" && command[i + 1] === "|") { parts.push(cur); cur = ""; i++; continue; }
    if (c === "&" && command[i + 1] === "&") { parts.push(cur); cur = ""; i++; continue; }
    if (c === ";" || c === "|") { parts.push(cur); cur = ""; continue; }
    cur += c;
  }
  if (quote) return null;
  parts.push(cur);
  return parts.filter((p) => p.trim() !== "");
}

function tokenize(statement: string): string[] | null {
  const tokens: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  let started = false;
  for (let i = 0; i < statement.length; i++) {
    const c = statement[i];
    if (quote) {
      if (c === quote) { quote = null; continue; }
      if (c === "$" && quote === '"') return null;
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; started = true; continue; }
    if (c === "\\") { cur += statement[++i] ?? ""; started = true; continue; }
    if (/\s/.test(c)) {
      if (started) { tokens.push(cur); cur = ""; started = false; }
      continue;
    }
    cur += c;
    started = true;
  }
  if (quote) return null;
  if (started) tokens.push(cur);
  return tokens;
}

export function analyzeShell(command: string): ShellAnalysis {
  if (/\beval\b/.test(command) || command.includes("`") || command.includes("$(") ||
      command.includes("<<")) {
    return FAIL;
  }
  const statements = splitStatements(command);
  if (!statements) return FAIL;
  const out: ShellStatement[] = [];
  for (const st of statements) {
    const tokens = tokenize(st);
    if (!tokens || tokens.length === 0) return FAIL;
    const redirects: ShellRedirect[] = [];
    const words: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === ">" || t === ">>") {
        const target = tokens[++i];
        if (!target || target.includes("$")) return FAIL;
        redirects.push({ target, mode: t === ">>" ? "append" : "write" });
        continue;
      }
      if (t.startsWith(">") || t.startsWith("<")) return FAIL;
      if (t.includes("$")) return FAIL;
      words.push(t);
    }
    if (words.length === 0) return FAIL;
    out.push({ program: words[0], args: words.slice(1), redirects });
  }
  return { ok: true, statements: out };
}
