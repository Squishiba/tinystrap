import { describe, expect, it } from "vitest";
import { HARNESS_NOTICE_TOOL, interruptionChunks, interruptionSse } from "@tinystrap/proxy";

const req = { model: "m", messages: [], stream: true };

describe("interruption rewrite", () => {
  it("produces a well-formed harness_notice completion", () => {
    const chunks = interruptionChunks(req, "outside workspace");
    expect(chunks[0].choices[0].delta.role).toBe("assistant");
    const call = chunks[1].choices[0].delta.tool_calls?.[0];
    expect(call?.function?.name).toBe(HARNESS_NOTICE_TOOL);
    expect(JSON.parse(call?.function?.arguments ?? "{}").reason).toBe("outside workspace");
    expect(chunks[2].choices[0].finish_reason).toBe("tool_calls");
  });
  it("SSE form ends with [DONE]", () => {
    expect(interruptionSse(req, "r")).toMatch(/\[DONE\]\n\n$/);
  });
});
