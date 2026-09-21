import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runDoctor } from "@tinystrap/core";
import { StubDiscovery } from "@tinystrap/discovery";

describe("doctor", () => {
  it("prints resolved values with sources", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ts-doc-"));
    writeFileSync(join(dir, "tinystrap.toml"), '[promotion]\nmode = "export_patch"\n');
    const out = await runDoctor(dir, new StubDiscovery({
      servers: [{ baseUrl: "http://127.0.0.1:8080", kind: "llamacpp",
        models: [{ id: "qwen", contextLength: 8192 }] }],
      selectedModel: "qwen", contextLength: 8192,
    }));
    expect(out).toContain("promotion.mode = export_patch   (project)");
    expect(out).toContain("server.model = qwen   (discovered)");
    expect(out).toContain("llamacpp http://127.0.0.1:8080");
  });
  it("reports probe failure without throwing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ts-doc-"));
    const out = await runDoctor(dir, {
      probe: () => Promise.reject(new Error("connection refused")),
    });
    expect(out).toContain("discovery failed: connection refused");
  });
});
