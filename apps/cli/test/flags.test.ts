import { isAbsolute } from "node:path";
import { describe, expect, it } from "vitest";
import { parseInitFlags } from "../src/flags.js";

const ok = (argv: string[]) => {
  const r = parseInitFlags(argv);
  if (!r.ok) throw new Error(`expected ok, got: ${r.message}`);
  return r.flags;
};
const err = (argv: string[]): string => {
  const r = parseInitFlags(argv);
  if (r.ok) throw new Error("expected a usage error");
  return r.message;
};

describe("init flag parsing", () => {
  it("defaults to a fully non-interactive run with the smoke test on", () => {
    const f = ok([]);
    expect(f).toEqual({ yes: false, url: undefined, model: undefined, dir: undefined,
      force: false, smoke: true });
  });
  it("reads the four documented flags", () => {
    const f = ok(["--yes", "--url", "http://127.0.0.1:9000", "--model", "m-a", "--force"]);
    expect(f.yes).toBe(true);
    expect(f.url).toBe("http://127.0.0.1:9000");
    expect(f.model).toBe("m-a");
    expect(f.force).toBe(true);
  });
  it("--no-smoke turns the tool-call check off", () => {
    expect(ok(["--no-smoke"]).smoke).toBe(false);
  });
  it("resolves --dir to an absolute path, so a relative one cannot surprise anyone", () => {
    const f = ok(["--dir", "sub/project"]);
    expect(f.dir !== undefined && isAbsolute(f.dir)).toBe(true);
  });
  it("rejects an unknown flag by name, and lists the real ones", () => {
    const m = err(["--nope"]);
    expect(m).toContain("--nope");
    expect(m).toContain("--yes");
    expect(m).toContain("--url");
    expect(m).toContain("--model");
    expect(m).toContain("--dir");
    expect(m).toContain("--force");
    expect(m).toContain("--no-smoke");
  });
  it("rejects a value flag with nothing after it", () => {
    expect(err(["--url"])).toContain("--url");
    expect(err(["--model"])).toContain("--model");
  });
  it("rejects a --url that is not a URL, and a non-http scheme", () => {
    expect(err(["--url", "not a url"])).toContain("--url");
    expect(err(["--url", "file:///etc/passwd"])).toContain("--url");
  });
  it("accepts a non-loopback --url: the operator asked for it explicitly", () => {
    expect(ok(["--url", "http://example.invalid:8080"]).url)
      .toBe("http://example.invalid:8080");
  });
});
