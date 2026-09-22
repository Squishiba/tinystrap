export type HarnessEventKind =
  | "tool_request" | "tool_allowed" | "tool_denied" | "tool_asked"
  | "evasion_flagged" | "script_rescanned" | "task_created"
  | "baseline_captured" | "patch_extracted" | "patch_exported"
  | "tool_stream_started" | "tool_interrupted" | "reasoning_intervention"
  | "tool_call_repaired";

export type HarnessEvent = {
  taskId: string;
  timestamp: string;
  kind: HarnessEventKind;
  tool?: string;
  argumentsDigest?: string;
  decision?: string;
  reason?: string;
  effectSignature?: string;
};

export function makeEvent(
  taskId: string,
  kind: HarnessEventKind,
  fields: Partial<Omit<HarnessEvent, "taskId" | "kind" | "timestamp">> = {},
): HarnessEvent {
  return { taskId, kind, timestamp: new Date().toISOString(), ...fields };
}
