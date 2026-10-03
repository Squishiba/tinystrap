import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runDoctor } from "@tinystrap/core";
import { StubDiscovery } from "@tinystrap/discovery";
import type { DiscoveredValues } from "@tinystrap/discovery";

const dir = (): string => mkdtempSync(join(tmpdir(), "ts-doc-"));

const withAttempts: DiscoveredValues = {
  servers: [],
  attempts: [
    { url: "http://127.0.0.1:8080/props", outcome: "ok", status: 200 },
    { url: "http://127.0.0.1:11434/props", outcome: "http-error", status: 404 },
    { url: "http://127.0.0.1:1234/v1/models", outcome: "unreachable", detail: "ECONNREFUSED" },
  ],
  probeSource: "loopback",
};

describe("doctor probe reporting", () => {
  it("lists every endpoint probed and what came back (spec 14)", async () => {
    const out = await runDoctor(dir(), new StubDiscovery(withAttempts));
    expect(out).toContain("probe attempts:");
    expect(out).toContain("http://127.0.0.1:8080/props");
    expect(out).toContain("http://127.0.0.1:11434/props");
    expect(out).toContain("ECONNREFUSED");
  });
  it("omits the section entirely when discovery reported no attempts", async () => {
    // Regression guard: the existing doctor.test.ts output shape must not change
    // for any discovery that does not report attempts (e.g. StubDiscovery).
    const out = await runDoctor(dir(), new StubDiscovery({ servers: [] }));
    expect(out).toContain("tinystrap doctor");
    expect(out).not.toContain("probe attempts:");
  });
  it("keeps the existing key = value (source) lines", async () => {
    const out = await runDoctor(dir(), new StubDiscovery({
      servers: [{ baseUrl: "http://127.0.0.1:8080", kind: "llamacpp", models: [{ id: "m-a" }] }],
      selectedModel: "m-a", contextLength: 8192, attempts: withAttempts.attempts,
    }));
    expect(out).toContain("server.model = m-a   (discovered)");
    expect(out).toContain("llamacpp http://127.0.0.1:8080");
    expect(out).toContain("probe attempts:");
  });
  it("prints the selected profile only when a resolver is supplied", async () => {
    const d = { probe: async () => ({ servers: [], selectedModel: "m-a" }) };
    expect(await runDoctor(dir(), d)).not.toContain("profile =");
    const out = await runDoctor(dir(), d, undefined,
      { resolveProfile: (m) => `profile-for-${m}` });
    expect(out).toContain("profile = profile-for-m-a   (profile)");
  });
});
