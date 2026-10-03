import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/init.js";
import { StubDiscovery } from "@tinystrap/discovery";
import { FakeProvider } from "@tinystrap/proxy";
import type { RecordedStream, StreamChunk } from "@tinystrap/proxy";
import { SMOKE_TOOL_NAME } from "@tinystrap/core";
import type { PromptIO } from "@tinystrap/core";
import type { DiscoveredValues } from "@tinystrap/discovery";

type Term = PromptIO & { output: string };

function io(answers: string[] = []): Term {
  const lines: string[] = [];
  const queue = [...answers];
  return {
    isTty: true,
    out: (l) => { lines.push(l); },
    err: (l) => { lines.push(l); },
    ask: async () => queue.shift() ?? "",
    get output() { return lines.join("\n"); },
  };
}

// Any file read back from disk is normalised, so a Windows checkout (CRLF) reads
// the same as a Linux one.
const read = (path: string): string => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

const found: DiscoveredValues = {
  servers: [{ baseUrl: "http://127.0.0.1:8080", kind: "llamacpp",
    models: [{ id: "m-a", contextLength: 8192 }] }],
  selectedModel: "m-a", contextLength: 8192,
  attempts: [{ url: "http://127.0.0.1:8080/props", outcome: "ok", status: 200 }],
  probeSource: "loopback",
};
const project = (): string => mkdtempSync(join(tmpdir(), "ts-init-e2e-"));

// startProxy/provider are injected: the orchestration tests must never open a
// socket. `neverStarted` makes it loud if the orchestrator decides on its own.
const neverStarted = (..._args: never[]): never => {
  throw new Error("the test must not start a proxy");
};
const smokeOk = async (): Promise<{ ok: boolean; toolCalls: number; detail: string }> =>
  ({ ok: true, toolCalls: 1, detail: "ok" });
const baseDeps = (term: PromptIO) => ({
  io: term, discovery: new StubDiscovery(found),
  startProxy: neverStarted, provider: neverStarted, smoke: smokeOk,
});

describe("tinystrap init", () => {
  it("writes one config, reports doctor, smokes, and prints host instructions", async () => {
    const dir = project();
    const r = await runInit(["--dir", dir], baseDeps(io()));
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, "tinystrap.toml"))).toBe(true);
    expect(read(join(dir, "tinystrap.toml"))).toContain('model = "m-a"');
    expect(r.output).toContain("tinystrap doctor");
    expect(r.output).toContain("@ai-sdk/openai-compatible");
    expect(r.output).toContain("does not edit");
  });
  it("writes exactly one file into the project, and nothing anywhere else", async () => {
    const dir = project();
    await runInit(["--dir", dir], baseDeps(io()));
    // The only file `init` ever creates. Host configs are printed, never written,
    // so there is no other path in runInit that touches the filesystem.
    expect(readdirSync(dir)).toEqual(["tinystrap.toml"]);
  });
  it("refuses an existing config, changes nothing, and exits 4", async () => {
    const dir = project();
    const deps = baseDeps(io());
    expect((await runInit(["--dir", dir], deps)).code).toBe(0);
    const before = read(join(dir, "tinystrap.toml"));
    const second = await runInit(["--dir", dir], deps);
    expect(second.code).toBe(4);
    expect(second.output).toContain("never overwrites it");
    expect(read(join(dir, "tinystrap.toml"))).toBe(before);
  });
  it("--force replaces it and exits 0", async () => {
    const dir = project();
    const deps = baseDeps(io());
    await runInit(["--dir", dir], deps);
    expect((await runInit(["--dir", dir, "--force"], deps)).code).toBe(0);
  });
  it("exits 2 with the usage line on a flag it does not know", async () => {
    const r = await runInit(["--nope"], baseDeps(io()));
    expect(r.code).toBe(2);
    expect(r.output).toContain("unknown flag: --nope");
    expect(r.output).toContain("usage: tinystrap init");
  });
  it("exits 3 and names every endpoint when nothing answers", async () => {
    const r = await runInit(["--dir", project()], {
      io: io(), discovery: new StubDiscovery({
        servers: [],
        attempts: [
          { url: "http://127.0.0.1:8080/props", outcome: "unreachable", detail: "ECONNREFUSED" },
          { url: "http://127.0.0.1:1234/v1/models", outcome: "unreachable", detail: "ECONNREFUSED" },
        ],
        probeSource: "loopback",
      }),
    });
    expect(r.code).toBe(3);
    expect(r.output).toContain("no model server answered");
    expect(r.output).toContain("http://127.0.0.1:8080/props");
    expect(r.output).toContain("http://127.0.0.1:1234/v1/models");
  });
  it("exits 5 when the model answers without calling a tool", async () => {
    const dir = project();
    const r = await runInit(["--dir", dir], {
      io: io(), discovery: new StubDiscovery(found),
      startProxy: neverStarted, provider: neverStarted,
      smoke: async () => ({ ok: false, toolCalls: 0,
        detail: "the model answered without calling the tool" }),
    });
    expect(r.code).toBe(5);
    expect(r.output).toContain("smoke test failed");
    // The config stays: a failed smoke is a report, not a rollback.
    expect(existsSync(join(dir, "tinystrap.toml"))).toBe(true);
    // ...and the setup notes it promises are actually printed.
    expect(r.output).toContain("@ai-sdk/openai-compatible");
  });
  it("--no-smoke skips the proxy entirely and exits 0", async () => {
    const dir = project();
    const r = await runInit(["--dir", dir, "--no-smoke"], {
      io: io(), discovery: new StubDiscovery(found),
      startProxy: neverStarted, provider: neverStarted,
    });
    expect(r.code).toBe(0);
  });
  it("--model the server does not serve exits 2 with the list of what it does", async () => {
    const r = await runInit(["--dir", project(), "--model", "nope"], {
      io: io(), discovery: new StubDiscovery(found),
      startProxy: neverStarted, provider: neverStarted,
    });
    expect(r.code).toBe(2);
    expect(r.output).toContain("is not served by");
    expect(r.output).toContain("m-a");
  });
  it("an interactive answer is required unless --yes", async () => {
    const term = io();
    term.isTty = false;
    const r = await runInit(["--dir", project()], {
      io: term, discovery: new StubDiscovery(found),
      startProxy: neverStarted, provider: neverStarted,
    });
    expect(r.code).toBe(2);
    expect(r.output).toContain("--yes");
  });
  it("--yes proceeds without a terminal", async () => {
    const term = io();
    term.isTty = false;
    expect((await runInit(["--dir", project(), "--yes"], {
      io: term, discovery: new StubDiscovery(found),
      startProxy: neverStarted, provider: neverStarted, smoke: smokeOk,
    })).code).toBe(0);
  });
  it("runs the real smoke leg against a proxy it starts itself", async () => {
    // The one case that exercises the un-injected path: a real startProxy on a
    // loopback port with a scripted provider behind it - the same socket the core
    // smoke test uses, so no external server is contacted.
    const stream: RecordedStream = {
      server: "scripted", attempt: "smoke", status: 200, summary: {},
      chunks: [
        { choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0,
            id: "call_1", function: { name: SMOKE_TOOL_NAME, arguments: "{\"ok\":true}" } }] },
          finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      ] as StreamChunk[],
    };
    const dir = project();
    const r = await runInit(["--dir", dir], {
      io: io(), discovery: new StubDiscovery(found),
      provider: () => new FakeProvider([stream]),
    });
    expect(r.code).toBe(0);
    expect(r.output).toContain("smoke test ok");
    expect(r.output).toContain(SMOKE_TOOL_NAME);
  });
  it("exits 5 on the real leg when the model streams nothing back", async () => {
    // Same real leg as the case above, with an empty recorded stream: the proxy is
    // up, the model never calls the probe tool, and init reports it instead of
    // throwing. The proxy it starts is closed again before runInit returns.
    const r = await runInit(["--dir", project()], {
      io: io(), discovery: new StubDiscovery(found),
      provider: () => new FakeProvider([{ server: "scripted", attempt: "empty", status: 200,
        chunks: [], summary: {} }]),
    });
    expect(r.code).toBe(5);
    expect(r.output).toContain("smoke test failed");
  });
});
