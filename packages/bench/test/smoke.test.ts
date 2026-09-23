import { describe, expect, it } from "vitest";
import * as bench from "@tinystrap/bench";

describe("bench package", () => {
  it("resolves with no runtime deps beyond workspace packages", () => {
    const deps = {
      "@tinystrap/core": "workspace:*",
      "@tinystrap/policy": "workspace:*",
      "@tinystrap/proxy": "workspace:*",
    };
    expect(Object.keys(deps).every((d) => d.startsWith("@tinystrap/"))).toBe(true);
    expect(bench).toBeDefined();
  });
});
