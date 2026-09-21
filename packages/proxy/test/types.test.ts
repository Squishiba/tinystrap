import { describe, expect, it } from "vitest";
import type { ChatRequest, StreamChunk, ToolCallDelta } from "@tinystrap/proxy";

describe("proxy types", () => {
  it("constructs a chunk shaped like the recorded llama.cpp stream", () => {
    const delta: ToolCallDelta = { index: 0, function: { arguments: "{" } };
    const chunk: StreamChunk = {
      choices: [{ index: 0, delta: { tool_calls: [delta] }, finish_reason: null }],
    };
    const req: ChatRequest = {
      model: "m", messages: [{ role: "user", content: "hi" }], stream: true,
      chat_template_kwargs: { enable_thinking: false },
    };
    expect(chunk.choices[0].delta.tool_calls?.[0].function?.arguments).toBe("{");
    expect(req.chat_template_kwargs).toEqual({ enable_thinking: false });
  });
});
