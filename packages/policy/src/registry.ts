import type { ToolDefinition } from "./types.js";

export interface ToolRegistry {
  register(def: ToolDefinition): void;
  lookup(name: string): ToolDefinition | undefined;
  all(): ToolDefinition[];
}

export function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, ToolDefinition>();
  return {
    register(def) {
      if (tools.has(def.name)) throw new Error(`duplicate tool: ${def.name}`);
      tools.set(def.name, def);
    },
    lookup: (name) => tools.get(name),
    all: () => [...tools.values()],
  };
}
