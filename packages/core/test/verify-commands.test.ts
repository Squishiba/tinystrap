import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectVerifyCommands, resolveVerifyCommands, verifyOverridesFromConfig } from "@tinystrap/core";

function project(setup: (dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "ts-vdetect-"));
  setup(dir);
  return dir;
}

describe("detectVerifyCommands", () => {
  it("detects package.json scripts in test/build/lint/typecheck order", () => {
    const dir = project((d) => writeFileSync(join(d, "package.json"), JSON.stringify({
      scripts: { typecheck: "tsc -b", lint: "eslint .", test: "vitest run", deploy: "node x" } })));
    expect(detectVerifyCommands(dir)).toEqual([
      { name: "test", command: "pnpm run test" },
      { name: "lint", command: "pnpm run lint" },
      { name: "typecheck", command: "pnpm run typecheck" },
    ]);
  });
  it("detects pytest from pytest.ini", () => {
    const dir = project((d) => writeFileSync(join(d, "pytest.ini"), "[pytest]\n"));
    expect(detectVerifyCommands(dir)).toEqual([{ name: "pytest", command: "pytest" }]);
  });
  it("detects pytest from a pyproject tool section", () => {
    const dir = project((d) => writeFileSync(join(d, "pyproject.toml"), "[tool.pytest.ini_options]\n"));
    expect(detectVerifyCommands(dir).map((c) => c.command)).toEqual(["pytest"]);
  });
  it("detects cargo and go", () => {
    const dir = project((d) => { writeFileSync(join(d, "Cargo.toml"), ""); writeFileSync(join(d, "go.mod"), ""); });
    expect(detectVerifyCommands(dir).map((c) => c.command).sort()).toEqual(["cargo test", "go test ./..."]);
  });
  it("detects a make test target only when present", () => {
    const withTarget = project((d) => writeFileSync(join(d, "Makefile"), "test:\n\techo ok\n"));
    const without = project((d) => writeFileSync(join(d, "Makefile"), "build:\n\techo ok\n"));
    expect(detectVerifyCommands(withTarget).map((c) => c.command)).toEqual(["make test"]);
    expect(detectVerifyCommands(without)).toEqual([]);
  });
  it("tolerates a malformed package.json", () => {
    const dir = project((d) => writeFileSync(join(d, "package.json"), "{not json"));
    expect(detectVerifyCommands(dir)).toEqual([]);
  });
});

describe("resolveVerifyCommands", () => {
  const detected = [
    { name: "test", command: "pnpm run test" },
    { name: "lint", command: "pnpm run lint" },
  ];
  it("an override replaces the detected command with the same name", () => {
    expect(resolveVerifyCommands(detected, { test: "pnpm vitest run" })).toEqual([
      { name: "test", command: "pnpm vitest run" },
      { name: "lint", command: "pnpm run lint" },
    ]);
  });
  it("an empty-string override disables a detected command", () => {
    expect(resolveVerifyCommands(detected, { lint: "" })).toEqual(
      [{ name: "test", command: "pnpm run test" }]);
  });
  it("an unknown key adds a new command", () => {
    expect(resolveVerifyCommands(detected, { smoke: "node smoke.mjs" })).toEqual([
      { name: "test", command: "pnpm run test" },
      { name: "lint", command: "pnpm run lint" },
      { name: "smoke", command: "node smoke.mjs" },
    ]);
  });
  it("non-string override values are ignored", () => {
    expect(resolveVerifyCommands(detected, { test: 42 })).toEqual(detected);
  });
});

describe("verifyOverridesFromConfig", () => {
  it("collects only verify.* keys, stripped", () => {
    const config = {
      "verify.test": { value: "pnpm vitest run", source: "project" as const },
      "promotion.mode": { value: "apply", source: "builtin" as const },
    };
    expect(verifyOverridesFromConfig(config)).toEqual({ test: "pnpm vitest run" });
  });
});
