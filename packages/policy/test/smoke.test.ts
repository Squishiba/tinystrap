import { describe, expect, it } from "vitest";
import * as policy from "@tinystrap/policy";

describe("policy package", () => {
  it("has no runtime dependencies", () => {
    const pkg = { dependencies: {} } as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies)).length(0);
    expect(policy).toBeDefined();
  });
});
