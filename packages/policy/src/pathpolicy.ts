function toSlashes(p: string): string {
  return p.replace(/\\/g, "/");
}

function lowerDrive(p: string): string {
  return /^[A-Za-z]:\//.test(p) ? p[0].toLowerCase() + p.slice(1) : p;
}

export function normalizePath(p: string, cwd: string): string {
  let s = toSlashes(p);
  if (!/^[A-Za-z]:\//.test(s) && !s.startsWith("/")) s = `${toSlashes(cwd)}/${s}`;
  const out: string[] = [];
  for (const seg of s.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  if (out.length > 0 && /^[A-Za-z]:$/.test(out[0])) {
    return lowerDrive(`${out[0]}/${out.slice(1).join("/")}`);
  }
  return `/${out.join("/")}`;
}

export function isInsideWorkspace(target: string, workspaceRoot: string): boolean {
  const t = normalizePath(target, "/");
  const r = normalizePath(workspaceRoot, "/");
  return t === r || t.startsWith(`${r}/`);
}

export function detectSymlinkEscape(
  target: string,
  workspaceRoot: string,
  realPaths: ReadonlyMap<string, string>,
): boolean {
  const t = normalizePath(target, "/");
  const r = normalizePath(workspaceRoot, "/");
  for (const [link, real] of realPaths) {
    const l = normalizePath(link, "/");
    const rr = normalizePath(real, "/");
    if (!isInsideWorkspace(rr, r) && (t === l || t.startsWith(`${l}/`))) {
      return true;
    }
  }
  return false;
}
