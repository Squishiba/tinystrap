import type { EffectRecord, ToolDefinition } from "./types.js";

export const PIN_NOTE_TOOL_NAME = "pin_note";

export const PIN_NOTE_TOOL: ToolDefinition = {
  name: PIN_NOTE_TOOL_NAME,
  description: "Pin a short decision, current plan item, or confirmed fact. " +
    "Max 5 notes, 200 chars each. {key, note} to set; {key, remove: true} to remove.",
  inputSchema: {
    type: "object",
    properties: {
      key: { type: "string" },
      note: { type: "string" },
      remove: { type: "boolean" },
    },
    required: ["key"],
  },
  capabilities: ["harness_state_write"],
  readOnly: false,
};

// Harness-state effect: never a filesystem target (spec 12.7). Used for audit
// effectSignature by the proxy when it executes the call.
export function effectsForHarnessTool(tool: string): EffectRecord[] {
  if (tool !== PIN_NOTE_TOOL_NAME) return [];
  return [{ target: "harness:notes", kind: "write", scope: "in_workspace" }];
}