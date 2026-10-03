import { describe, expect, it } from "vitest";
import { LOCAL_PORTS, isLoopbackUrl, localTargets } from "@tinystrap/discovery";

describe("loopback port policy", () => {
  it("probes the three default local servers, in a fixed order", () => {
    // 8080 llama.cpp, 11434 Ollama, 1234 LM Studio - the three local servers in
    // spec section 8. Fixed order so probe output is reproducible.
    expect(LOCAL_PORTS).toEqual([8080, 11434, 1234]);
    expect(localTargets()).toEqual([
      "http://127.0.0.1:8080",
      "http://127.0.0.1:11434",
      "http://127.0.0.1:1234",
    ]);
  });
  it("accepts every loopback spelling and nothing else", () => {
    expect(isLoopbackUrl("http://127.0.0.1:8080")).toBe(true);
    expect(isLoopbackUrl("http://localhost:1234")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:1234")).toBe(true);
    expect(isLoopbackUrl("http://example.invalid:8080")).toBe(false);
    expect(isLoopbackUrl("not a url")).toBe(false);
    expect(isLoopbackUrl("")).toBe(false);
  });
  it("every default target is loopback", () => {
    // The global constraint, asserted: the sweep can never leave the machine.
    for (const t of localTargets()) expect(isLoopbackUrl(t)).toBe(true);
  });
});

import { LocalDiscovery, describeAttempts } from "@tinystrap/discovery";
import type { ProbeFetch } from "@tinystrap/discovery";

function refuse(): ProbeFetch {
  return async () => {
    throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  };
}

describe("LocalDiscovery sweep", () => {
  it("records one attempt per endpoint per target and explains a total miss", async () => {
    const values = await new LocalDiscovery({ fetchImpl: refuse() }).probe();
    expect(values.servers).toEqual([]);
    expect(values.probeSource).toBe("loopback");
    // Two routes per target (spec section 8: /props and /v1/models) x three targets.
    expect(values.attempts).toHaveLength(6);
    expect(values.attempts?.every((a) => a.outcome === "unreachable")).toBe(true);
    expect(values.attempts?.[0].url).toBe("http://127.0.0.1:8080/props");
    expect(values.attempts?.[0].detail).toBe("ECONNREFUSED");
  });
  it("distinguishes a live endpoint from a dead one", async () => {
    const fetchImpl: ProbeFetch = async (url) => {
      if (new URL(url).port === "8080" && new URL(url).pathname === "/v1/models") {
        return { status: 200, json: async () => ({ data: [{ id: "m-a" }] }) };
      }
      if (new URL(url).port === "8080") return { status: 404, json: async () => ({}) };
      throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    };
    const values = await new LocalDiscovery({ fetchImpl }).probe();
    const byUrl = Object.fromEntries((values.attempts ?? []).map((a) => [a.url, a]));
    expect(byUrl["http://127.0.0.1:8080/props"].outcome).toBe("http-error");
    expect(byUrl["http://127.0.0.1:8080/props"].status).toBe(404);
    expect(byUrl["http://127.0.0.1:8080/v1/models"].outcome).toBe("ok");
    expect(byUrl["http://127.0.0.1:11434/props"].outcome).toBe("unreachable");
    // Task 3 turns a 200 /v1/models body into an offered server: the live responder
    // is now reported, the unreachable targets are not.
    expect(values.servers.map((s) => s.baseUrl)).toEqual(["http://127.0.0.1:8080"]);
  });
  it("describeAttempts names every endpoint and its result, for a non-expert", () => {
    const text = describeAttempts([
      { url: "http://127.0.0.1:8080/props", outcome: "http-error", status: 404 },
      { url: "http://127.0.0.1:8080/v1/models", outcome: "unreachable", detail: "ECONNREFUSED" },
    ]);
    expect(text).toBe("probed: http://127.0.0.1:8080/props (404), http://127.0.0.1:8080/v1/models (ECONNREFUSED)");
  });
});

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

// The doubles above never touch a socket, so they cannot catch a bug in the default
// fetch path. These bind a real listener on 127.0.0.1 with an ephemeral port and
// probe it - loopback only, no external network, no model server.
async function startFake(
  routes: Record<string, { status: number; body: unknown }>,
): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const route = routes[new URL(req.url ?? "/", "http://127.0.0.1").pathname];
    if (!route) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    res.writeHead(route.status, { "content-type": "application/json" });
    res.end(JSON.stringify(route.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// Bind then release to obtain a loopback port nothing is listening on.
async function closedPort(): Promise<string> {
  const server = await startFake({});
  const base = server.base;
  await server.close();
  return base;
}

describe("LocalDiscovery over real loopback sockets", () => {
  it("reads a real 200, a real 404 and a real refusal off the wire", async () => {
    const live = await startFake({ "/v1/models": { status: 200, body: { data: [{ id: "m-a" }] } } });
    const dead = await closedPort();
    try {
      const values = await new LocalDiscovery({ targets: [live.base, dead] }).probe();
      const byUrl = Object.fromEntries((values.attempts ?? []).map((a) => [a.url, a]));
      expect(values.attempts).toHaveLength(4);
      expect(byUrl[`${live.base}/v1/models`].outcome).toBe("ok");
      expect(byUrl[`${live.base}/v1/models`].status).toBe(200);
      expect(byUrl[`${live.base}/props`].outcome).toBe("http-error");
      expect(byUrl[`${live.base}/props`].status).toBe(404);
      expect(byUrl[`${dead}/props`].outcome).toBe("unreachable");
      expect(byUrl[`${dead}/props`].detail).toBe("ECONNREFUSED");
      expect(values.probeSource).toBe("loopback");
    } finally {
      await live.close();
    }
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyResponder } from "@tinystrap/discovery";

// The recorded llama.cpp bodies (spec section 8: /props carries model_alias,
// default_generation_settings.n_ctx, build_info, total_slots, chat_template_caps).
// The same fixture packages/discovery/test/llamacpp.test.ts:6-7 already reads.
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

describe("responder classification", () => {
  it("identifies llama.cpp and takes model, context length, and kind from it", () => {
    const s = classifyResponder("http://127.0.0.1:8080", recorded()["/props"], recorded()["/v1/models"]);
    expect(s).not.toBeNull();
    expect(s?.kind).toBe("llamacpp");
    expect(s?.baseUrl).toBe("http://127.0.0.1:8080");
    expect(s?.models[0].contextLength).toBe(128000);
    // llama.cpp reports model_alias as the full GGUF path, so the id contains
    // slashes. Assert against the recorded fixture rather than a literal.
    const recordedIds = ((recorded()["/v1/models"] as { data: Array<{ id: string }> }).data)
      .map((e) => e.id);
    expect(s?.models.map((m) => m.id)).toEqual(recordedIds);
  });
  it("falls back to openai-compatible for an ambiguous /v1/models responder", () => {
    // Spec section 8 marks Ollama and LM Studio identification "to verify", so an
    // unidentified OpenAI-shaped responder is labelled, never guessed at.
    const s = classifyResponder("http://127.0.0.1:1234", {}, { data: [{ id: "m-a" }, { id: "m-b" }] });
    expect(s?.kind).toBe("openai-compatible");
    expect(s?.models.map((m) => m.id)).toEqual(["m-a", "m-b"]);
    // No /props means no n_ctx: never invent a context length.
    expect(s?.models[0].contextLength).toBeUndefined();
  });
  it("rejects a listener that answers 404 or with no models", () => {
    expect(classifyResponder("http://127.0.0.1:9000", {}, {})).toBeNull();
    expect(classifyResponder("http://127.0.0.1:9000", {}, { data: [] })).toBeNull();
  });
  it("classifies a vLLM-shaped responder as openai-compatible, not llama.cpp", () => {
    // vLLM serves /v1/models in OpenAI shape and has no /props: a 404 there. Its
    // entries carry owned_by "vllm" and a max_model_len, neither of which is a
    // llama.cpp shape, so identifyLlamaCpp must reject it and the OpenAI-compatible
    // label must take over. Reading max_model_len is out of scope for this task - a
    // context length we have not verified is worse than none, per spec section 8.
    const props404 = {};
    const vllm = {
      object: "list",
      data: [{
        id: "m-a", object: "model", created: 1700000000, owned_by: "vllm",
        root: "m-a", parent: null, max_model_len: 4096,
      }],
    };
    const s = classifyResponder("http://127.0.0.1:8000", props404, vllm);
    expect(s?.kind).toBe("openai-compatible");
    expect(s?.models.map((m) => m.id)).toEqual(["m-a"]);
    expect(s?.models[0].contextLength).toBeUndefined();
  });
  it("keeps a llama.cpp responder that lists no models, so the no-models message has a server to name", () => {
    // A /props body with build_info + model_alias identifies llama.cpp on shape alone
    // (identifyLlamaCpp's first route), yet a server with nothing loaded has no data[]
    // entries and no readable n_ctx. It stays a server - kind and baseUrl are what the
    // "load a model, or pass --model" message needs - but offers no model and no
    // invented context length.
    const s = classifyResponder(
      "http://127.0.0.1:9000", { build_info: "b1", model_alias: "m-a" }, { data: [] },
    );
    expect(s?.kind).toBe("llamacpp");
    expect(s?.models).toEqual([]);
  });
  it("falls back to model_alias when /v1/models lists nothing but /props has the facts", () => {
    const props = recorded()["/props"] as { model_alias: string };
    const s = classifyResponder("http://127.0.0.1:8080", props, { data: [] });
    expect(s?.kind).toBe("llamacpp");
    expect(s?.models).toHaveLength(1);
    // Asserted against the recorded alias, never a literal path.
    expect(s?.models[0].id).toBe(props.model_alias);
    expect(s?.models[0].contextLength).toBe(128000);
  });
  it("probe() now offers the discovered server, with context length and selection", async () => {
    const bodies = recorded();
    const fetchImpl: ProbeFetch = async (url) => {
      const body = bodies[new URL(url).pathname];
      return body
        ? { status: 200, json: async () => body }
        : { status: 404, json: async () => ({}) };
    };
    const values = await new LocalDiscovery({
      targets: ["http://127.0.0.1:8080"], fetchImpl,
    }).probe();
    expect(values.servers).toHaveLength(1);
    expect(values.selectedModel).toBe(values.servers[0].models[0].id);
    expect(values.contextLength).toBe(128000);
    expect(values.probeSource).toBe("loopback");
  });
  it("probeSource is url when the operator supplied a non-loopback target", async () => {
    const bodies = recorded();
    const fetchImpl: ProbeFetch = async (url) => {
      const body = bodies[new URL(url).pathname];
      return body
        ? { status: 200, json: async () => body }
        : { status: 404, json: async () => ({}) };
    };
    const values = await new LocalDiscovery({
      targets: ["http://example.invalid:8080"], fetchImpl,
    }).probe();
    expect(values.probeSource).toBe("url");
    expect(values.servers).toHaveLength(1);
  });
  it("classifies a real vLLM-shaped listener over a real loopback socket", async () => {
    // End-to-end through the default fetch path: nothing here talks to a model
    // server, only to a fake listener on an ephemeral loopback port.
    const fake = await startFake({
      "/v1/models": {
        status: 200,
        body: {
          object: "list",
          data: [{ id: "m-a", object: "model", owned_by: "vllm", root: "m-a", max_model_len: 4096 }],
        },
      },
    });
    try {
      const values = await new LocalDiscovery({ targets: [fake.base] }).probe();
      expect(values.servers).toHaveLength(1);
      expect(values.servers[0].kind).toBe("openai-compatible");
      expect(values.servers[0].models).toEqual([{ id: "m-a" }]);
      expect(values.selectedModel).toBe("m-a");
      expect(values.contextLength).toBeUndefined();
      expect(describeAttempts(values.attempts ?? []))
        .toBe(`probed: ${fake.base}/props (404), ${fake.base}/v1/models (200)`);
    } finally {
      await fake.close();
    }
  });
});
