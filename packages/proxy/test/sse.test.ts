import { describe, expect, it } from "vitest";
import { SSE_DONE, formatSse, parseSseRecords } from "@tinystrap/proxy";

describe("sse", () => {
  it("parses data records and stops at [DONE]", () => {
    const raw = [
      'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
      "event: ignored",
      'data: {"choices":[{"index":0,"delta":{"content":"x"},"finish_reason":"stop"}]}',
      "data: [DONE]",
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"never"}]}',
    ].join("\n\n");
    const chunks = parseSseRecords(raw);
    expect(chunks.length).toBe(2);
    expect(chunks[1].choices[0].finish_reason).toBe("stop");
  });
  it("round-trips through formatSse", () => {
    const chunk = { choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] };
    expect(parseSseRecords(formatSse(chunk))).toEqual([chunk]);
    expect(SSE_DONE).toBe("data: [DONE]\n\n");
  });
});
