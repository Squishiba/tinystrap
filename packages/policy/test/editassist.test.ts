import { describe, expect, it } from "vitest";
import { sliceAround, findNormalizedMatches, extractSpan, closestLines } from "@tinystrap/policy";

const FILE = [
  "function add(a, b) {",
  "  return a+b;",
  "}",
  "",
  "const x = 1;",
].join("\n");

describe("editassist", () => {
  it("sliceAround clamps to file bounds", () => {
    const s = sliceAround(FILE, 0, 1);
    expect(s).toEqual({ startLine: 0, endLine: 1,
      text: "function add(a, b) {\n  return a+b;" });
  });
  it("finds a whitespace-normalized match and extracts the ORIGINAL text", () => {
    const spans = findNormalizedMatches(FILE, "return  a + b");
    expect(spans).toEqual([{ startLine: 1, endLine: 1 }]);
    expect(extractSpan(FILE, spans[0])).toBe("  return a+b;");
  });
  it("reports every match for ambiguous oldText", () => {
    const dup = "a\nb\na\nb";
    expect(findNormalizedMatches(dup, "a\nb")).toEqual(
      [{ startLine: 0, endLine: 1 }, { startLine: 2, endLine: 3 }]);
  });
  it("no match returns empty; closestLines ranks by overlap", () => {
    expect(findNormalizedMatches(FILE, "nothing here at all")).toEqual([]);
    const near = closestLines(FILE, "  return a + b; extra", 2);
    expect(near[0].line).toBe(1);
  });
});