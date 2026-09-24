import type { WireTool } from "@tinystrap/policy";

export type ChatRole = "system" | "user" | "assistant" | "tool";
export type ChatMessage = {
  role: ChatRole;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};
export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};
export type ToolCallDelta = {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
};
export type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  tools?: WireTool[];
  tool_choice?: "auto" | "required" | "none";
  stream?: boolean;
  chat_template_kwargs?: Record<string, unknown>;
};
export type StreamChunk = {
  choices: {
    index: number;
    delta: {
      role?: string;
      content?: string | null;
      reasoning_content?: string;
      tool_calls?: ToolCallDelta[];
    };
    finish_reason: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};
export interface Provider {
  stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamChunk>;
}
