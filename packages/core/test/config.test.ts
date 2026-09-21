import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "@tinystrap/core";

function project(toml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ts-cfg-"));
  writeFileSync(join(dir, "tinystrap.toml"), toml);
  return dir;
}

describe("config loader", () => {
  it("applies builtin defaults", async () => {
    const c = await loadConfig({ projectRoot: project("") });
    expect(c["promotion.mode"]).toEqual({ value: "apply", source: "builtin" });
  });
  it("project file beats discovered, cli beats project", async () => {
    const dir = project('[server]\nmodel = "proj-model"\n');
    const c = await loadConfig({
      projectRoot: dir,
      discovered: {
        servers: [{ baseUrl: "http://127.0.0.1:8080", kind: "llamacpp",
          models: [{ id: "disc" }] }],
        selectedModel: "disc",
        contextLength: 8192,
      },
      cli: { "server.model": "cli-model" },
    });
    expect(c["server.model"]).toEqual({ value: "cli-model", source: "cli" });
    expect(c["server.baseUrl"]).toEqual({ value: "http://127.0.0.1:8080", source: "discovered" });
    expect(c["context.length"]).toEqual({ value: 8192, source: "discovered" });
  });
  it("user defaults file sits below discovered", async () => {
    const dir = project("");
    const user = join(dir, "defaults.toml");
    writeFileSync(user, '[server]\nmodel = "user-model"\n');
    const c = await loadConfig({
      projectRoot: dir,
      userDefaultsPath: user,
      discovered: {
        servers: [{ baseUrl: "http://x", kind: "ollama", models: [{ id: "d" }] }],
        selectedModel: "d",
      },
    });
    expect(c["server.model"]).toEqual({ value: "d", source: "discovered" });
  });
  it("maps snake_case toml keys to dotted camelCase", async () => {
    const c = await loadConfig({
      projectRoot: project('[snapshot]\nallow_ignored_dirs = ["node_modules"]\n'),
    });
    expect(c["snapshot.allowIgnoredDirs"])
      .toEqual({ value: ["node_modules"], source: "project" });
  });
});
