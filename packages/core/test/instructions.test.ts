import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROXY_BASE_URL, renderHostInstructions } from "@tinystrap/core";

const project = (): string => mkdtempSync(join(tmpdir(), "ts-instr-"));
const configPath = (): string => join(project(), "tinystrap.toml");

describe("host setup instructions", () => {
  const text = renderHostInstructions({ model: "m-a", configPath: configPath() });

  it("prints an OpenCode provider block matching the adapter's own shape", () => {
    // adapters/opencode/src/config.ts:53 builds exactly this: one provider named
    // tinystrap, npm @ai-sdk/openai-compatible, baseURL <proxy>/v1, apiKey tinystrap.
    expect(text).toContain("@ai-sdk/openai-compatible");
    expect(text).toContain(DEFAULT_PROXY_BASE_URL + "/v1");
    expect(text).toContain('"m-a"');
    expect(text).toContain("provider");
  });
  it("renders the OpenCode snippet as JSON with the adapter's exact shape", () => {
    // Structural, not string-compared, so key order in the renderer cannot make
    // this flaky - and a shape drift from buildOpenCodeConfig fails here.
    const block = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    const parsed = JSON.parse(block) as {
      provider: Record<string, { npm: string; name: string;
        options: { baseURL: string; apiKey: string };
        models: Record<string, Record<string, never>> }>;
    };
    expect(parsed.provider.tinystrap).toEqual({
      npm: "@ai-sdk/openai-compatible",
      name: "tinystrap proxy",
      options: { baseURL: `${DEFAULT_PROXY_BASE_URL}/v1`, apiKey: "tinystrap" },
      models: { "m-a": {} },
    });
  });
  it("prints the pi endpoint as the env var PiRunner actually sets", () => {
    // adapters/pi/src/runner.ts:42 sets OPENAI_BASE_URL; the comment above it
    // marks the mechanism UNVERIFIED, so the text must not claim it is confirmed.
    expect(text).toContain("OPENAI_BASE_URL");
    expect(text).toContain("unverified");
  });
  it("never claims to have written a host config", () => {
    expect(text.toLowerCase()).toContain("does not edit");
    // The operator pastes it; tinystrap does not.
    expect(text.toLowerCase()).toContain("paste");
  });
  it("writes nothing at all: it is text, not a config editor", () => {
    const dir = project();
    renderHostInstructions({ model: "m-a", configPath: join(dir, "tinystrap.toml") });
    expect(readdirSync(dir)).toEqual([]);
  });
  it("names the config file it wrote, so the operator can find it", () => {
    const dir = project();
    const path = join(dir, "tinystrap.toml");
    expect(renderHostInstructions({ model: "m-a", configPath: path })).toContain(path);
  });
  it("honours an explicit proxy URL", () => {
    const t = renderHostInstructions({ model: "m-a", proxyBaseUrl: "http://127.0.0.1:9000",
      configPath: configPath() });
    expect(t).toContain("http://127.0.0.1:9000/v1");
  });
});
