import { checkExistingFileWrite, checkReadBeforeEdit } from "./guards.js";
import { detectSymlinkEscape } from "./pathpolicy.js";
import { effectsFromFile, effectsFromShell } from "./effects.js";
import { analyzeShell } from "./shell.js";
import { analyzePythonAst } from "./python.js";
import type { EvasionTracker } from "./evasion.js";
import type { ScriptLedger } from "./provenance.js";
import type { ToolRegistry } from "./registry.js";
import type { EffectRecord, Phase, PolicyDecision, ToolRequest } from "./types.js";

export type PolicyContext = {
  workspaceRoot: string;
  registry: ToolRegistry;
  phaseAllowlists?: Partial<Record<Phase, readonly string[]>>;
  readSet: ReadonlySet<string>;
  exists: (normalizedPath: string) => boolean;
  realPaths: ReadonlyMap<string, string>;
  ledger: ScriptLedger;
  evasion: EvasionTracker;
  pythonAst?: unknown;
};

const FILE_TOOLS = new Set(["read", "write", "edit", "apply_patch", "delete"]);

function deny(reason: string, correction?: string, retryable = true): PolicyDecision {
  return { effect: "deny", reason, correction, retryable };
}

export function evaluate(req: ToolRequest, ctx: PolicyContext): PolicyDecision {
  const def = ctx.registry.lookup(req.tool);
  if (!def) {
    const names = ctx.registry.all().map((t) => t.name).join(", ");
    return deny(`unknown_tool: \`${req.tool}\` does not exist in this environment.`,
      `No action was performed. Available tools: ${names}.`);
  }
  const allowed = ctx.phaseAllowlists?.[req.phase];
  if (allowed && !allowed.includes(req.tool)) {
    return deny(`phase_denied: \`${req.tool}\` is unavailable in phase \`${req.phase}\`.`,
      "No action was performed.", false);
  }

  let effects: EffectRecord[] = [];
  if (req.tool === "bash" || req.tool === "run") {
    const command = String(req.args.command ?? "");
    const analysis = analyzeShell(command);
    if (!analysis.ok) {
      return deny("argument_denied: unclassifiable shell command (fail closed).",
        "Simplify the command: no eval, subshells, expansions, or heredocs.", false);
    }
    effects = effectsFromShell(analysis, req.cwd, ctx.workspaceRoot);
  } else if (req.tool === "python") {
    const a = analyzePythonAst(ctx.pythonAst);
    if (a.unparseable) {
      return deny("argument_denied: python source could not be parsed (fail closed).",
        undefined, false);
    }
    if (a.dangerous.length > 0) {
      return deny(`argument_denied: dangerous python calls: ${a.dangerous.map((d) => d.name).join(", ")}.`,
        undefined, false);
    }
  } else if (FILE_TOOLS.has(req.tool)) {
    effects = effectsFromFile(req.tool, String(req.args.path ?? ""), ctx.workspaceRoot);
  }

  if (effects.length > 0 && ctx.evasion.check(effects).flagged) {
    return deny("argument_denied: evasion_flagged — this repeats a denied effect via another tool.",
      "Stop attempting this effect.", false);
  }

  for (const e of effects) {
    if (e.scope === "out_of_workspace") {
      return deny("argument_denied: Target is outside the task workspace.",
        "Use a path inside the task workspace.");
    }
  }
  if (FILE_TOOLS.has(req.tool)) {
    const target = effects[0]?.target ?? "";
    if (detectSymlinkEscape(target, ctx.workspaceRoot, ctx.realPaths)) {
      return deny("argument_denied: Target escapes the workspace through a link.",
        "Use a real path inside the task workspace.");
    }
    if (req.tool === "write" && ctx.exists(target)) {
      return checkExistingFileWrite(true);
    }
    if ((req.tool === "edit" || req.tool === "apply_patch") &&
        !ctx.readSet.has(target)) {
      return checkReadBeforeEdit(target, ctx.readSet);
    }
  }

  if (effects.some((e) => e.kind === "git" && e.target === "push")) {
    return deny("argument_denied: git push is forbidden.",
      "No shell process was started. Commit locally instead.", false);
  }

  return { effect: "allow" };
}
