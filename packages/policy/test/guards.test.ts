import { describe, expect, it } from "vitest";
import { checkExistingFileWrite, checkReadBeforeEdit } from "@tinystrap/policy";

describe("guards", () => {
  it("allows write to new file, denies existing", () => {
    expect(checkExistingFileWrite(false)).toEqual({ effect: "allow" });
    const d = checkExistingFileWrite(true);
    expect(d.effect).toBe("deny");
    if (d.effect === "deny") {
      expect(d.correction).toMatch(/`edit` or `apply_patch`/);
      expect(d.retryable).toBe(true);
    }
  });
  it("denies edit before read", () => {
    const d = checkReadBeforeEdit("src/a.ts", new Set(["src/b.ts"]));
    expect(d.effect).toBe("deny");
    if (d.effect === "deny") expect(d.reason).toContain("src/a.ts");
  });
  it("allows edit after read", () => {
    expect(checkReadBeforeEdit("src/a.ts", new Set(["src/a.ts"])))
      .toEqual({ effect: "allow" });
  });
  it("embeds a file slice in the correction when one is provided", () => {
    const d = checkReadBeforeEdit("a.ts", new Set(),
      { startLine: 3, text: "const x = 1;\nconst y = 2;" });
    expect(d.effect).toBe("deny");
    expect(d.effect === "deny" && d.correction).toContain("Current content (from line 4):");
    expect(d.effect === "deny" && d.correction).toContain("const y = 2;");
  });
});
