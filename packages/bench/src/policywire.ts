// Per-run policy wiring: the deferred composition from the proxy plan lands
// here — a real PolicyContext built once per run, exposed to the proxy's
// stream gate as a Preflight closure over evaluate(). The supervisor should
// reuse this rather than rebuild it (spec-vs-code gap 4 of the bench plan).
//
// Deviation from the plan: `makeBenchRegistry` was added. On main,
// createToolRegistry() returns an EMPTY registry, so a bare registry would
// short-circuit every tool call to `unknown_tool` in the gate before the
// engine's real checks (workspace scope, existing-file write, read-before-edit,
// shell policy) could ever run. The bench registers minimal definitions for
// the canonical tool vocabulary so scenarios reach full validation.

import {
  createToolRegistry, evaluate, EvasionTracker, ScriptLedger, normalizePath,
} from "@tinystrap/policy";
import type { Phase, ToolRegistry } from "@tinystrap/policy";
import type { Preflight } from "@tinystrap/proxy";

export function makePreflight(ctx: {
  workspaceRoot: string;
  registry: ToolRegistry;
  taskId: string;
  phase: Phase;
  readSet?: Set<string>;
  exists?: (p: string) => boolean;
}): Preflight {
  const state = {
    workspaceRoot: ctx.workspaceRoot,
    registry: ctx.registry,
    readSet: ctx.readSet ?? new Set<string>(),
    exists: ctx.exists ?? (() => false),
    realPaths: new Map<string, string>(),
    ledger: new ScriptLedger(),
    evasion: new EvasionTracker(),
  };
  return (tool, args) => {
    const decision = evaluate(
      { tool, args, cwd: ctx.workspaceRoot, taskId: ctx.taskId, phase: ctx.phase },
      state,
    );
    // Read-before-edit bookkeeping: the engine denies edit/apply_patch on any
    // path missing from readSet, and nothing else in the bench wiring ever
    // populates it — without this, EVERY edit is denied no matter what the
    // model does, so every coding task fails regardless of model quality.
    // Record successful reads (canonical vocabulary, post-dialect mapping;
    // grep/glob also count as reads per effects.ts READ_TOOLS).
    if (READ_TOOLS.has(tool) && decision.effect === "allow") {
      const p = typeof args.path === "string" ? args.path : "";
      if (p !== "") state.readSet.add(normalizePath(p, ctx.workspaceRoot));
    }
    return decision;
  };
}

const READ_TOOLS = new Set(["read", "grep", "glob"]);

// The canonical vocabulary the seed suite exercises. `deploy_to_prod` is
// deliberately absent: safety-unknown-tool must reach the engine's
// unknown_tool denial, not the gate's name check on an empty registry.
const BENCH_TOOLS = ["read", "write", "edit", "apply_patch", "delete", "bash", "run", "python"];

export function makeBenchRegistry(): ToolRegistry {
  const registry = createToolRegistry();
  for (const name of BENCH_TOOLS) {
    registry.register({
      name, description: name, inputSchema: {}, capabilities: [], readOnly: name === "read",
    });
  }
  return registry;
}
