import type { PolicyDecision, ToolRegistry } from "@tinystrap/policy";
import type { StreamChunk, ToolCall } from "./types.js";

export type Preflight = (tool: string, args: Record<string, unknown>) => PolicyDecision;

export type GateAction =
  | { kind: "forward"; chunk: StreamChunk }
  | { kind: "interrupt"; reason: string; tool: string | undefined };

type Partial = { id: string; name?: string; args: string; checked: boolean };

function balancedJson(s: string): boolean {
  let depth = 0; let inStr = false; let esc = false;
  for (const c of s) {
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{" || c === "[") depth++;
    if (c === "}" || c === "]") depth--;
  }
  return depth === 0 && (s.trim().startsWith("{") || s.trim().startsWith("["));
}

export class StreamGate {
  private parts = new Map<number, Partial>();
  private tripped: GateAction | undefined;

  constructor(private readonly opts: { registry: ToolRegistry; preflight: Preflight }) {}

  accumulated(): ToolCall[] {
    return [...this.parts.values()].filter((p) => p.name !== undefined).map((p) => ({
      id: p.id, type: "function" as const,
      function: { name: p.name as string, arguments: p.args },
    }));
  }

  push(chunk: StreamChunk): GateAction {
    if (this.tripped) return this.tripped;
    const choice = chunk.choices[0];
    if (!choice) return { kind: "forward", chunk };
    for (const d of choice.delta.tool_calls ?? []) {
      const part = this.parts.get(d.index) ?? { id: d.id ?? `call_${d.index}`, args: "", checked: false };
      if (d.id) part.id = d.id;
      this.parts.set(d.index, part);
      if (d.function?.name !== undefined && part.name === undefined) {
        part.name = d.function.name;
        if (!this.opts.registry.lookup(part.name)) {
          return this.trip(`unknown_tool: \`${part.name}\``, part.name);
        }
      }
      if (d.function?.arguments !== undefined && part.name) {
        part.args += d.function.arguments;
        if (!part.checked && balancedJson(part.args)) {
          part.checked = true;
          const decision = this.check(part);
          if (decision) return decision;
        }
      }
    }
    if (choice.finish_reason === "tool_calls") {
      for (const part of this.parts.values()) {
        if (!part.checked) {
          part.checked = true;
          const decision = this.check(part);
          if (decision) return decision;
        }
      }
    }
    return { kind: "forward", chunk };
  }

  private check(part: Partial): GateAction | undefined {
    if (!part.name) return undefined;
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(part.args) as Record<string, unknown>; }
    catch { parsed = { _raw: part.args }; }
    const d = this.opts.preflight(part.name, parsed);
    if (d.effect === "rewrite") {
      part.args = JSON.stringify(d.args);
      return undefined;
    }
    if (d.effect === "deny" || d.effect === "ask") {
      return this.trip(d.reason, part.name);
    }
    return undefined;
  }

  private trip(reason: string, tool: string | undefined): GateAction {
    this.tripped = { kind: "interrupt", reason, tool };
    return this.tripped;
  }
}
