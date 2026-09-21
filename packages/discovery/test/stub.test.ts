import { describe, expect, it } from "vitest";
import { StubDiscovery } from "@tinystrap/discovery";

describe("stub discovery", () => {
  it("returns the values it was constructed with", async () => {
    const values = {
      servers: [{ baseUrl: "http://127.0.0.1:8080", kind: "llamacpp" as const,
        models: [{ id: "qwen", contextLength: 8192 }] }],
      selectedModel: "qwen",
      contextLength: 8192,
    };
    expect(await new StubDiscovery(values).probe()).toEqual(values);
  });
});
