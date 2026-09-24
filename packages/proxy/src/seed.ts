import type { HostDialect, ToolRegistry, WireTool } from "@tinystrap/policy";
import type { ToolCall } from "./types.js";

// The request's own `tools` array is ground truth for what the host can execute
// (live-check F3 cause 1). Duplicate entries are skipped: registry.register throws.
export function seedRegistry(
  registry: ToolRegistry, tools: readonly WireTool[] | undefined, dialect: HostDialect,
): number {
  if (!tools) return 0;
  let added = 0;
  for (const tool of tools) {
    const name = tool?.function?.name;
    if (!name || registry.lookup(name)) continue;
    registry.register(dialect.toolDefinition(tool));
    added++;
  }
  return added;
}

function parseArgs(raw: string): Record<string, unknown> {
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
}

// For consumers that read the canonical vocabulary (guidance.recordCalls, stall
// detection): rewrite host calls without touching the bytes that go to the host.
export function canonicalizeCalls(dialect: HostDialect, calls: readonly ToolCall[]): ToolCall[] {
  return calls.map((c) => ({
    ...c,
    function: {
      name: dialect.canonicalName(c.function.name),
      arguments: JSON.stringify(dialect.toCanonicalArgs(c.function.name, parseArgs(c.function.arguments))),
    },
  }));
}
