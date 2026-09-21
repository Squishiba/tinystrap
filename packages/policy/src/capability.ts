import type { Phase, ToolDefinition } from "./types.js";
import type { ToolRegistry } from "./registry.js";

export function compileToolList(
  phase: Phase,
  registry: ToolRegistry,
  allowlists?: Partial<Record<Phase, readonly string[]>>,
): ToolDefinition[] {
  const allowed = allowlists?.[phase];
  const tools = registry.all();
  if (!allowed) return tools;
  const set = new Set(allowed);
  return tools.filter((t) => set.has(t.name));
}
