import { isInsideWorkspace, normalizePath } from "./pathpolicy.js";
import type { ShellAnalysis } from "./shell.js";
import type { EffectKind, EffectRecord } from "./types.js";

const READ_TOOLS = new Set(["read", "grep", "glob"]);
const WRITE_TOOLS = new Set(["write", "edit", "apply_patch"]);

function scope(target: string, workspaceRoot: string): EffectRecord["scope"] {
  return isInsideWorkspace(target, workspaceRoot) ? "in_workspace" : "out_of_workspace";
}

export function effectsFromFile(tool: string, path: string, workspaceRoot: string): EffectRecord[] {
  const target = normalizePath(path, workspaceRoot);
  const kind: EffectKind = READ_TOOLS.has(tool) ? "read"
    : WRITE_TOOLS.has(tool) ? "write"
    : tool === "delete" ? "delete" : "exec";
  return [{ target, kind, scope: scope(target, workspaceRoot) }];
}

export function effectsFromShell(analysis: ShellAnalysis, cwd: string, workspaceRoot: string): EffectRecord[] {
  if (!analysis.ok) return [];
  const out: EffectRecord[] = [];
  const add = (target: string, kind: EffectKind) => {
    const t = kind === "exec" || kind === "git" || kind === "network"
      ? target : normalizePath(target, cwd);
    out.push({ target: t, kind, scope: scope(t, normalizePath(workspaceRoot, "/")) });
  };
  for (const st of analysis.statements) {
    add(st.program, "exec");
    for (const r of st.redirects) add(r.target, "write");
    const last = st.args[st.args.length - 1];
    if (["rm", "unlink"].includes(st.program)) {
      for (const a of st.args) if (!a.startsWith("-")) add(a, "delete");
    } else if (["cp", "mv", "install", "tee"].includes(st.program)) {
      if (last) add(last, "write");
    } else if (st.program === "sed" && st.args.some((a) => a.startsWith("-i"))) {
      const file = [...st.args].reverse().find((a) => !a.startsWith("-"));
      if (file) add(file, "write");
    } else if (st.program === "git") {
      if (st.args[0]) add(st.args[0], "git");
    } else if (["curl", "wget", "ssh", "nc"].includes(st.program)) {
      const host = st.args.find((a) => !a.startsWith("-"));
      if (host) add(host, "network");
    }
  }
  return out;
}

export function effectSignature(effects: EffectRecord[]): string {
  return [...new Set(effects.map((e) => `${e.kind}:${e.target}`))].sort().join("|");
}
