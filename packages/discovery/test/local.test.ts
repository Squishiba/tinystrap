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
    // No classification yet: Task 3 turns a 200 /v1/models body into a server.
    expect(values.servers).toEqual([]);
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
