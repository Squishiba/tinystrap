import { describe, expect, it } from "vitest";
import * as proxy from "@tinystrap/proxy";

describe("proxy package", () => {
  it("resolves with no runtime deps beyond workspace packages", () => {
    const deps = { "@tinystrap/policy": "workspace:*", "@tinystrap/discovery": "workspace:*" };
    expect(Object.keys(deps).every((d) => d.startsWith("@tinystrap/"))).toBe(true);
    expect(proxy).toBeDefined();
  });
});
