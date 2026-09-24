import type { ToolDefinition } from "./types.js";

// One entry of the `tools` array as a host sends it on the wire (OpenAI function
// format — verified against fixtures/opencode-tools.json; NOT the ToolDefinition
// shape main's ChatRequest.tools wrongly declares, see plan gap 3).
export type WireTool = {
  type: "function";
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
};

export type HostToolDisposition = "allow" | "deny";

// Pure host/canonical bridge: no I/O (spec 6 purity rule for this package).
export interface HostDialect {
  readonly id: string;
  readonly supportsHarnessNotice: boolean;
  canonicalName(hostTool: string): string;
  toCanonicalArgs(hostTool: string, hostArgs: Record<string, unknown>): Record<string, unknown>;
  toHostArgs(hostTool: string, canonicalArgs: Record<string, unknown>): Record<string, unknown>;
  toolDefinition(tool: WireTool): ToolDefinition;
  disposition(hostTool: string): HostToolDisposition;
}

export type DialectSpec = {
  id: string;
  supportsHarnessNotice: boolean;
  nameMap?: Record<string, string>;
  argMaps: Record<string, Record<string, string>>;
  capabilities?: Record<string, string[]>;
  readOnly?: readonly string[];
  dispositions?: Record<string, HostToolDisposition>;
};

function rename(map: Record<string, string>, args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) out[map[k] ?? k] = v;
  return out;
}

function invert(map: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [from, to] of Object.entries(map)) out[to] = from;
  return out;
}

export function buildDialect(spec: DialectSpec): HostDialect {
  return {
    id: spec.id,
    supportsHarnessNotice: spec.supportsHarnessNotice,
    canonicalName: (hostTool) => spec.nameMap?.[hostTool] ?? hostTool,
    toCanonicalArgs: (hostTool, hostArgs) => rename(spec.argMaps[hostTool] ?? {}, hostArgs),
    toHostArgs: (hostTool, canonicalArgs) => rename(invert(spec.argMaps[hostTool] ?? {}), canonicalArgs),
    toolDefinition: (tool) => ({
      name: tool.function.name,
      description: tool.function.description ?? "",
      inputSchema: tool.function.parameters ?? {},
      capabilities: spec.capabilities?.[tool.function.name] ?? [],
      readOnly: spec.readOnly?.includes(tool.function.name) ?? false,
    }),
    disposition: (hostTool) => spec.dispositions?.[hostTool] ?? "allow",
  };
}

// Correct for hosts that already speak the canonical vocabulary (tinystrap's own
// fixture tools, the scripted stand-in). pi is NOT known to be canonical — its
// argument names are unverified (spec 13.2); do not use this for pi until verified.
export function createIdentityDialect(): HostDialect {
  return buildDialect({ id: "canonical", supportsHarnessNotice: true, argMaps: {} });
}
