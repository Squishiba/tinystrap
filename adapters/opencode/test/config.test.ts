import { describe, expect, it } from "vitest";
import { buildOpenCodeConfig } from "@tinystrap/adapter-opencode";

describe("buildOpenCodeConfig", () => {
  it("points the tinystrap provider at the proxy URL with /v1 appended", () => {
    const cfg = buildOpenCodeConfig("http://127.0.0.1:54321", "qwen2.5-coder-7b");
    const p = cfg.provider.tinystrap;
    expect(p.npm).toBe("@ai-sdk/openai-compatible");
    expect(p.options.baseURL).toBe("http://127.0.0.1:54321/v1");
    expect(p.models["qwen2.5-coder-7b"]).toEqual({});
  });
  it("tolerates a trailing slash on the proxy URL exactly once", () => {
    const cfg = buildOpenCodeConfig("http://127.0.0.1:54321/", "m");
    expect(cfg.provider.tinystrap.options.baseURL).toBe("http://127.0.0.1:54321/v1");
  });
  it("refuses non-loopback proxy URLs (spec 10.1: host talks only to the proxy)", () => {
    expect(() => buildOpenCodeConfig("https://api.openai.com", "m")).toThrow(/loopback/);
    expect(() => buildOpenCodeConfig("http://example.invalid", "m")).toThrow(/loopback/);
  });
});