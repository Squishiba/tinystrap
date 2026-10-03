import { describe, expect, it } from "vitest";
import { LOCAL_PORTS, isLoopbackUrl, localTargets } from "@tinystrap/discovery";

describe("loopback port policy", () => {
  it("probes the three default local servers, in a fixed order", () => {
    // 8080 llama.cpp, 11434 Ollama, 1234 LM Studio - the three local servers in
    // spec section 8. Fixed order so probe output is reproducible.
    expect(LOCAL_PORTS).toEqual([8080, 11434, 1234]);
    expect(localTargets()).toEqual([
      "http://127.0.0.1:8080",
      "http://127.0.0.1:11434",
      "http://127.0.0.1:1234",
    ]);
  });
  it("accepts every loopback spelling and nothing else", () => {
    expect(isLoopbackUrl("http://127.0.0.1:8080")).toBe(true);
    expect(isLoopbackUrl("http://localhost:1234")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:1234")).toBe(true);
    expect(isLoopbackUrl("http://example.invalid:8080")).toBe(false);
    expect(isLoopbackUrl("not a url")).toBe(false);
    expect(isLoopbackUrl("")).toBe(false);
  });
  it("every default target is loopback", () => {
    // The global constraint, asserted: the sweep can never leave the machine.
    for (const t of localTargets()) expect(isLoopbackUrl(t)).toBe(true);
  });
});
