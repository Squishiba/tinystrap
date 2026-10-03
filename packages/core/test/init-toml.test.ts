import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "smol-toml";
import { loadConfig, renderInitToml } from "@tinystrap/core";

const values = {
  baseUrl: "http://127.0.0.1:8080", model: "m-a", kind: "llamacpp" as const,
  contextLength: 8192,
};

describe("init config renderer", () => {
  it("emits the keys the loader actually reads, verified through the same parser", () => {
    const parsed = parse(renderInitToml(values)) as Record<string, Record<string, unknown>>;
    // snake_case on disk, camelCase after KEY_MAP (config.ts:18-22): base_url -> baseUrl.
    expect(parsed.server.base_url).toBe("http://127.0.0.1:8080");
    expect(parsed.server.model).toBe("m-a");
    // [context] length flattens to context.length, the same key discovery sets (config.ts:65).
    expect(parsed.context.length).toBe(8192);
    expect(parsed.promotion.mode).toBe("apply");
  });
  it("keeps the comments that explain each table", () => {
    const text = renderInitToml(values);
    expect(text.startsWith("#")).toBe(true);
    expect(text).toContain("# tinystrap.toml");
    expect(text).toContain("base_url");
    expect(text).toContain("# Where the model server lives");
  });
  it("omits the context table entirely when the length is unknown", () => {
    // Never invent a context length: an absent table falls back to discovery.
    const text = renderInitToml({ ...values, contextLength: undefined });
    expect(text).not.toContain("[context]");
    expect(parse(text) as Record<string, unknown>).not.toHaveProperty("context");
  });
  it("escapes a model id that contains quotes or backslashes", () => {
    // llama.cpp reports model_alias as a full GGUF path, so ids carry slashes; a
    // quoting bug here would produce a file loadConfig cannot read.
    const odd = 'm"x\\y';
    const parsed = parse(renderInitToml({ ...values, model: odd })) as {
      server: { model: string } };
    expect(parsed.server.model).toBe(odd);
  });
  it("is read back by loadConfig under the keys the loader declares", async () => {
    // The real contract is not "parses" but "the loader resolves these keys from the
    // project file": KEY_MAP turns base_url into baseUrl, so the dotted key is
    // server.baseUrl, matching BUILTIN in config.ts.
    const dir = mkdtempSync(join(tmpdir(), "ts-toml-"));
    writeFileSync(join(dir, "tinystrap.toml"), renderInitToml(values), "utf8");
    const config = await loadConfig({ projectRoot: dir });
    expect(config["server.baseUrl"]).toEqual({
      value: "http://127.0.0.1:8080", source: "project",
    });
    expect(config["server.model"]?.value).toBe("m-a");
    expect(config["context.length"]?.value).toBe(8192);
    expect(config["promotion.mode"]?.source).toBe("project");
  });
});
