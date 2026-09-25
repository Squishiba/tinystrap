import { compileToolList } from "@tinystrap/policy";
import type { HostDialect, Phase, ToolDefinition, ToolRegistry, WireTool } from "@tinystrap/policy";

export function toWireTool(def: ToolDefinition): WireTool {
  return { type: "function",
    function: { name: def.name, description: def.description, parameters: def.inputSchema } };
}

// Spec 9.6/11: unavailable tools are omitted from the model request, not merely
// denied at preflight time. Harness-owned extras (pin_note) are always offered
// when their feature is on — the phase allowlist governs host tools.
export function compileForwardedTools(opts: {
  registry: ToolRegistry;
  phase: Phase;
  phaseAllowlists?: Partial<Record<Phase, readonly string[]>>;
  dialect: HostDialect;
  extraTools?: readonly ToolDefinition[];
}): WireTool[] {
  const compiled = compileToolList(opts.phase, opts.registry, opts.phaseAllowlists)
    .filter((t) => opts.dialect.disposition(t.name) !== "deny");
  const extras = (opts.extraTools ?? [])
    .filter((t) => !compiled.some((c) => c.name === t.name));
  return [...compiled, ...extras].map(toWireTool);
}
