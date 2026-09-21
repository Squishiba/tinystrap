import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LlamaCppDiscovery, extractLlamaCppFacts, identifyLlamaCpp } from "@tinystrap/discovery";

const FIXTURE = join(
  process.cwd(), "docs", "superpowers", "spike-findings", "fixtures", "discovery.jsonl");

function recorded(): Record<string, unknown> {
  const bodies: Record<string, unknown> = {};
  for (const line of readFileSync(FIXTURE, "utf8").split(/\r?\n/).filter(Boolean)) {
    const rec = JSON.parse(line) as { endpoint: string; body: unknown };
    bodies[rec.endpoint] = rec.body;
  }
  return bodies;
}

function fakeFetch(bodies: Record<string, unknown>) {
  return async (url: string) => {
    const path = new URL(url).pathname;
    const body = bodies[path];
    if (!body) return { status: 404, json: async () => ({}) };
    return { status: 200, json: async () => body };
  };
}

describe("llama.cpp discovery", () => {
  it("extracts facts from the recorded /props body using corrected paths", () => {
    const facts = extractLlamaCppFacts(recorded()["/props"]);
    expect(facts).not.toBeNull();
    expect(facts?.nCtx).toBe(128000);
    expect(facts?.buildInfo).toBe("b10934-acecd5603");
    expect(facts?.totalSlots).toBe(4);
    expect(facts?.chatTemplateCaps.supports_tool_calls).toBe(true);
  });
  it("identifies llama.cpp by shape and rejects foreign responders", () => {
    expect(identifyLlamaCpp(recorded()["/props"], recorded()["/v1/models"])).toBe(true);
    expect(identifyLlamaCpp({}, {})).toBe(false);
    expect(identifyLlamaCpp({ build_info: "x" }, { data: [{ owned_by: "ollama" }] })).toBe(false);
  });
  it("probe yields the model from /v1/models data[] (not the models[] compat array)", async () => {
    const d = new LlamaCppDiscovery({ baseUrl: "http://x", fetchImpl: fakeFetch(recorded()) });
    const values = await d.probe();
    expect(values.servers.length).toBe(1);
    expect(values.servers[0].kind).toBe("llamacpp");
    expect(values.selectedModel).toBe(d.lastFacts()?.modelAlias);
    expect(values.contextLength).toBe(128000);
  });
  it("404 responder yields no servers", async () => {
    const d = new LlamaCppDiscovery({ baseUrl: "http://x", fetchImpl: fakeFetch({}) });
    expect((await d.probe()).servers).toEqual([]);
    expect(d.lastFacts()).toBeNull();
  });
});
