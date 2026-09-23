import { describe, expect, it } from "vitest";
import * as adapter from "@tinystrap/adapter-opencode";

describe("adapter-opencode package", () => {
  it("resolves with only workspace deps", () => {
    expect(adapter).toBeDefined();
  });
});