import { describe, expect, it } from "vitest";
import { detectSymlinkEscape, isInsideWorkspace, normalizePath } from "@tinystrap/policy";

describe("path policy", () => {
  it("normalizes windows separators and dot segments", () => {
    expect(normalizePath("src\\..\\secrets\\a.txt", "C:/work/proj"))
      .toBe("c:/work/proj/secrets/a.txt");
  });
  it("resolves relative against cwd", () => {
    expect(normalizePath("b/c.txt", "/task/ws")).toBe("/task/ws/b/c.txt");
  });
  it("containment is exact-root-safe", () => {
    expect(isInsideWorkspace("/task/ws/a.ts", "/task/ws")).toBe(true);
    expect(isInsideWorkspace("/task/ws", "/task/ws")).toBe(true);
    expect(isInsideWorkspace("/task/wsneighbour/a", "/task/ws")).toBe(false);
    expect(isInsideWorkspace("/etc/passwd", "/task/ws")).toBe(false);
  });
  it("detects symlink escape via realPaths", () => {
    const real = new Map([["/task/ws/link", "/home/user/private"]]);
    expect(detectSymlinkEscape("/task/ws/link/x", "/task/ws", real)).toBe(true);
    expect(detectSymlinkEscape("/task/ws/ok/x", "/task/ws", real)).toBe(false);
  });
});
