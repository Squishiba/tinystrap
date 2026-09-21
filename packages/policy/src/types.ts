export type Phase = "planning" | "implementation" | "verification" | "promotion";

export type EffectKind = "read" | "write" | "delete" | "exec" | "network" | "git" | "secret";

export type EffectRecord = {
  target: string;
  kind: EffectKind;
  scope: "in_workspace" | "out_of_workspace";
};

export type PolicyDecision =
  | { effect: "allow" }
  | { effect: "ask"; reason: string }
  | { effect: "deny"; reason: string; correction?: string; retryable: boolean }
  | { effect: "rewrite"; args: unknown; reason: string };

export type ToolRequest = {
  tool: string;
  args: Record<string, unknown>;
  cwd: string;
  taskId: string;
  phase: Phase;
};

export type JsonSchema = Record<string, unknown>;

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  capabilities: string[];
  readOnly: boolean;
};
