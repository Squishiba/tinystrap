import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigExistsError, writeInitConfig } from "@tinystrap/core";

const values = {
  baseUrl: "http://127.0.0.1:8080", model: "m-a", kind: "llamacpp" as const,
  contextLength: 8192,
};
const project = (name = "ts-init-"): string => mkdtempSync(join(tmpdir(), name));

// CI runs on windows-latest, where a file written with LF can read back with CRLF.
// Every content comparison below goes through this, as verify.test.ts / patch.test.ts do.
const read = (path: string): string => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

describe("init config writer", () => {
  it("creates the one config file and reports where it went", () => {
    const dir = project();
    const r = writeInitConfig({ projectRoot: dir, values });
    expect(r.created).toBe(true);
    expect(r.overwritten).toBe(false);
    expect(existsSync(join(dir, "tinystrap.toml"))).toBe(true);
    expect(r.path).toBe(join(dir, "tinystrap.toml"));
  });
  it("refuses to clobber an existing file, byte for byte", () => {
    const dir = project();
    const path = join(dir, "tinystrap.toml");
    // A user's own hand-edited file, comments and all.
    const mine = "# mine\n[server]\nmodel = \"hand-picked\"\n";
    writeFileSync(path, mine);
    expect(() => writeInitConfig({ projectRoot: dir, values }))
      .toThrow(ConfigExistsError);
    expect(read(path)).toBe(mine);
  });
  it("the refusal message tells a non-expert exactly what to do", () => {
    const dir = project();
    writeInitConfig({ projectRoot: dir, values });
    try {
      writeInitConfig({ projectRoot: dir, values });
      throw new Error("should have refused");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigExistsError);
      const e = err as ConfigExistsError;
      expect(e.path).toBe(join(dir, "tinystrap.toml"));
      expect(e.message).toContain("never overwrites it");
      expect(e.message).toContain("--force");
    }
  });
  it("force replaces the file and says so", () => {
    const dir = project();
    writeInitConfig({ projectRoot: dir, values });
    const r = writeInitConfig({ projectRoot: dir, values: { ...values, model: "m-b" }, force: true });
    expect(r.overwritten).toBe(true);
    expect(r.created).toBe(false);
    expect(read(join(dir, "tinystrap.toml"))).toContain('model = "m-b"');
  });
  it("is idempotent: a second init without --force changes nothing", () => {
    const dir = project();
    writeInitConfig({ projectRoot: dir, values });
    const before = read(join(dir, "tinystrap.toml"));
    expect(() => writeInitConfig({ projectRoot: dir, values })).toThrow(ConfigExistsError);
    expect(read(join(dir, "tinystrap.toml"))).toBe(before);
  });
  it("handles a project path containing a space, on any platform", () => {
    const dir = project("ts-init-with space-");
    expect(dir).toContain(" ");
    const r = writeInitConfig({ projectRoot: dir, values });
    expect(existsSync(r.path)).toBe(true);
  });
});
