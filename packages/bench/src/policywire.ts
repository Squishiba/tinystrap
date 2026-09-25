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
  createToolRegistry, evaluate, EvasionTracker, ScriptLedger,
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
  return (tool, args) => evaluate(
    { tool, args, cwd: ctx.workspaceRoot, taskId: ctx.taskId, phase: ctx.phase },
    state,
  );
}

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
