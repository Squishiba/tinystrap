import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadTask, runLiveTask, parseBenchLiveArgs, sanitizeRunResult, formatProgressLine,
  resolveOperatorPath,
} from "@tinystrap/bench";
import type { BenchRunResult } from "@tinystrap/bench";
import { FakeProvider } from "@tinystrap/proxy";
import type { ChatRequest, StreamChunk } from "@tinystrap/proxy";
import { createOpenCodeDialect } from "@tinystrap/policy";
import type { HostTask, HostRunResult } from "@tinystrap/core";
import { FakeHostRunner } from "./helpers/fakehost.js";

const tasksRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "tasks");

const unusedStream = [{
  server: "bench", attempt: "unused", status: 200,
  chunks: [{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }], summary: {},
}];

// The py verify commands need pytest on the machine running the tests; skip
// the python end-to-end test cleanly when it is absent (CI setup-python does
// not install pytest).
const havePytest =
  spawnSync("python", ["-m", "pytest", "--version"], { stdio: "pipe" }).status === 0;

const FIXED_SUM = [
  "export function sum(nums) {",
  "  let total = 0;",
  "  for (let i = 0; i < nums.length; i++) total += nums[i];",
  "  return total;",
  "}",
  "",
].join("\n");

describe("parseBenchLiveArgs", () => {
  it("parses the required flags and applies defaults", () => {
    const a = parseBenchLiveArgs(["--base-url", "http://model.test:8080", "--model", "some-model"]);
    expect(a.baseUrl).toBe("http://model.test:8080");
    expect(a.model).toBe("some-model");
    expect(a.tasks).toBeNull();
    expect(a.configs).toBeNull();
    expect(a.repeat).toBe(1);
    expect(a.timeoutMs).toBe(600_000);
    expect(a.out).toBeNull();
    expect(a.label).toBe("model");
    expect(a.list).toBe(false);
  });

  it("requires --base-url and --model unless --list", () => {
    expect(() => parseBenchLiveArgs([])).toThrow(/--base-url/);
    expect(() => parseBenchLiveArgs(["--base-url", "http://model.test:8080"])).toThrow(/--model/);
    expect(() => parseBenchLiveArgs(["--list"])).not.toThrow();
    expect(parseBenchLiveArgs(["--list"]).list).toBe(true);
  });

  it("rejects an invalid base URL but accepts any scheme/host (LAN servers allowed)", () => {
    expect(() => parseBenchLiveArgs(["--base-url", "not a url", "--model", "m"])).toThrow(/base-url/);
    expect(() => parseBenchLiveArgs(
      ["--base-url", "http://model.test:1234/v1", "--model", "m"],
    )).not.toThrow();
  });

  it("parses list, numeric and label flags", () => {
    const a = parseBenchLiveArgs([
      "--base-url", "http://model.test:8080", "--model", "m",
      "--tasks", "ts-off-by-one,py-factorial", "--configs", "full,bare",
      "--repeat", "3", "--timeout-ms", "60000", "--out", "some/dir", "--label", "small7b",
    ]);
    expect(a.tasks).toEqual(["ts-off-by-one", "py-factorial"]);
    expect(a.configs).toEqual(["full", "bare"]);
    expect(a.repeat).toBe(3);
    expect(a.timeoutMs).toBe(60_000);
    expect(a.out).toBe(resolve("some/dir"));
    expect(a.debugDir).toBeNull();
    expect(a.label).toBe("small7b");
  });

  it("resolves --out and --debug-dir to absolute paths", () => {
    const base = ["--base-url", "http://model.test:8080", "--model", "m"];
    const a = parseBenchLiveArgs([...base, "--debug-dir", "dbg"]);
    expect(a.debugDir).toBe(resolve("dbg"));
    const b = parseBenchLiveArgs([...base, "--out", resolve("abs", "out")]);
    expect(b.out).toBe(resolve("abs", "out"));
  });

  it("rejects MSYS-style /c/... --out and --debug-dir on win32 only", () => {
    expect(() => resolveOperatorPath("/c/some/dir", "win32")).toThrow(/MSYS/);
    expect(() => resolveOperatorPath("/c", "win32")).toThrow(/MSYS/);
    expect(resolveOperatorPath("/c/some/dir", "linux")).toBe(resolve("/c/some/dir"));
    expect(resolveOperatorPath("D:\\bench-out", "win32")).toBe(resolve("D:\\bench-out"));
    expect(() => parseBenchLiveArgs([
      "--base-url", "http://model.test:8080", "--model", "m", "--out", "",
    ])).toThrow(/--out/);
  });

  it("rejects non-positive or non-integer --repeat / --timeout-ms", () => {
    const base = ["--base-url", "http://model.test:8080", "--model", "m"];
    expect(() => parseBenchLiveArgs([...base, "--repeat", "0"])).toThrow(/repeat/);
    expect(() => parseBenchLiveArgs([...base, "--repeat", "abc"])).toThrow(/repeat/);
    expect(() => parseBenchLiveArgs([...base, "--timeout-ms", "-5"])).toThrow(/timeout-ms/);
  });
});

function fakeResult(over: Partial<BenchRunResult> = {}): BenchRunResult {
  return {
    taskId: "ts-off-by-one",
    config: "full",
    resolved: true,
    metrics: {
      turns: 2, tokensPrompt: 10, tokensCompletion: 5, wallMs: 100,
      toolDenied: 0, toolInterrupted: 0, toolCallRepaired: 0,
      evasionFlagged: 0, reasoningInterventions: 0,
    },
    verify: { passed: true, exitCode: 0, outputTail: "leaked marker: /tmp/secret-dir/copy" },
    hostResult: {
      exitCode: 0, events: [], timedOut: false, cancelled: false,
      transcriptPath: "/tmp/secret-dir/logs/host-transcript.jsonl",
    },
    ...over,
  };
}

describe("sanitizeRunResult", () => {
  it("keeps the safe fields and drops every path-bearing field", () => {
    const rec = sanitizeRunResult(fakeResult(), "small7b");
    expect(rec.label).toBe("small7b");
    expect(rec.verify).toEqual({ passed: true, exitCode: 0 });
    expect(rec.host).toEqual({ exitCode: 0, timedOut: false, cancelled: false });
    const json = JSON.stringify(rec);
    expect(json).not.toContain("secret");
    expect(json).not.toContain("transcriptPath");
    expect(json).not.toContain("outputTail");
  });

  it("maps a safety result (no verify, no host) to nulls", () => {
    const rec = sanitizeRunResult(fakeResult({ verify: null, hostResult: null }), "model");
    expect(rec.verify).toBeNull();
    expect(rec.host).toBeNull();
  });
});

describe("formatProgressLine", () => {
  it("prints task, config, pass/fail, duration and tokens", () => {
    const line = formatProgressLine(fakeResult(), "small7b");
    expect(line).toContain("ts-off-by-one");
    expect(line).toContain("[full]");
    expect(line).toContain("PASS");
    expect(line).toContain("wall=100ms");
    expect(line).toContain("tokens=10/5");
    expect(line).toContain("label=small7b");
    expect(line.split("\n")).toHaveLength(1);
  });
});

const FIXED_MATHX = [
  "def factorial(n):",
  "    if n <= 1:",
  "        return 1",
  "    return n * factorial(n - 1)",
  "",
].join("\n");

// A scripted stand-in for a real host that actually talks to the proxy:
// POSTs an OpenAI-style streaming chat completion with an OpenCode-shaped
// tools array, parses the tool_calls out of the SSE response and executes
// them against the workspace (read = no-op, edit = string replace), exactly
// like opencode would. This is what proves the GATE lets a legitimate
// read-then-edit flow through: a gate denial never reaches the host as a
// tool call, so an interrupted run leaves the fixture unfixed.
class ScriptedHostRunner {
  constructor(private readonly tools: unknown[]) {}

  async run(task: HostTask): Promise<HostRunResult> {
    const res = await fetch(`${task.proxyBaseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: task.model, stream: true,
        messages: [{ role: "user", content: task.prompt }],
        tools: this.tools,
      }),
    });
    const sse = await res.text();
    const calls = new Map<number, { name: string; args: string }>();
    for (const block of sse.split("\n\n")) {
      for (const line of block.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "" || payload === "[DONE]") continue;
        const chunk = JSON.parse(payload) as StreamChunk;
        for (const d of chunk.choices[0]?.delta?.tool_calls ?? []) {
          const part = calls.get(d.index) ?? { name: "", args: "" };
          if (d.function?.name) part.name = d.function.name;
          if (d.function?.arguments) part.args += d.function.arguments;
          calls.set(d.index, part);
        }
      }
    }
    for (const call of calls.values()) {
      if (call.name !== "edit") continue;
      const a = JSON.parse(call.args) as { filePath: string; oldString: string; newString: string };
      const file = join(task.workspaceDir, a.filePath);
      writeFileSync(file, readFileSync(file, "utf8").replace(a.oldString, a.newString));
    }
    const transcriptPath = join(task.logsDir, "host-transcript.jsonl");
    writeFileSync(transcriptPath, "");
    return { exitCode: 0, events: [], transcriptPath, timedOut: false, cancelled: false };
  }
}

const OPENCODE_TOOLS = [
  { type: "function", function: { name: "read", parameters: {
    type: "object", properties: { filePath: { type: "string" } } } } },
  { type: "function", function: { name: "edit", parameters: {
    type: "object",
    properties: { filePath: { type: "string" }, oldString: { type: "string" }, newString: { type: "string" } } } } },
];

const READ_THEN_EDIT_CHUNKS: StreamChunk[] = [
  { choices: [{ index: 0, finish_reason: null, delta: { role: "assistant", tool_calls: [
    { index: 0, id: "c0", function: { name: "read", arguments: "" } }] } }] },
  { choices: [{ index: 0, finish_reason: null, delta: { tool_calls: [
    { index: 0, function: { arguments: JSON.stringify({ filePath: "sum.js" }) } }] } }] },
  { choices: [{ index: 0, finish_reason: null, delta: { tool_calls: [
    { index: 1, id: "c1", function: { name: "edit", arguments: "" } }] } }] },
  { choices: [{ index: 0, finish_reason: null, delta: { tool_calls: [
    { index: 1, function: { arguments: JSON.stringify({
      filePath: "sum.js", oldString: "let i = 1;", newString: "let i = 0;" }) } }] } }] },
  { choices: [{ index: 0, finish_reason: "tool_calls", delta: {} }] },
];

describe("runLiveTask (offline stand-in: fake host + fake provider)", () => {
  it("passes the operator model and timeout to the host and resolves the task", async () => {
    const task = loadTask(join(tasksRoot, "ts-off-by-one"));
    let seen: HostTask | null = null;
    const host = {
      run: async (t: HostTask): Promise<HostRunResult> => {
        seen = t;
        return new FakeHostRunner((dir) => {
          writeFileSync(join(dir, "sum.js"), FIXED_SUM);
        }).run(t);
      },
    };
    const result = await runLiveTask(task, {
      host,
      provider: new FakeProvider(unusedStream),
      dialect: createOpenCodeDialect(),
      model: "operator-model-id",
      config: "no-tool-call-repair",
      tasksRoot,
      timeoutMs: 12_345,
    });
    expect(seen).not.toBeNull();
    expect(seen!.model).toBe("operator-model-id");
    expect(seen!.timeoutMs).toBe(12_345);
    expect(seen!.proxyBaseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(result.config).toBe("no-tool-call-repair");
    expect(result.verify?.passed).toBe(true);
    expect(result.resolved).toBe(true);
    expect(result.hostResult?.exitCode).toBe(0);
  }, 120_000);

  it.skipIf(!havePytest)("resolves py-factorial when a scripted fake host applies the fix", async () => {
    const task = loadTask(join(tasksRoot, "py-factorial"));
    const result = await runLiveTask(task, {
      host: new FakeHostRunner((dir) => {
        writeFileSync(join(dir, "mathx.py"), FIXED_MATHX);
      }),
      provider: new FakeProvider(unusedStream),
      dialect: createOpenCodeDialect(),
      model: "operator-model-id",
      tasksRoot,
    });
    expect(result.verify?.passed).toBe(true);
    expect(result.resolved).toBe(true);
  }, 120_000);

  it("resolves ts-off-by-one through the real gate when a scripted host reads then edits", async () => {
    const task = loadTask(join(tasksRoot, "ts-off-by-one"));
    const result = await runLiveTask(task, {
      host: new ScriptedHostRunner(OPENCODE_TOOLS),
      provider: new FakeProvider([{
        server: "bench", attempt: "s1", status: 200,
        chunks: READ_THEN_EDIT_CHUNKS, summary: {},
      }]),
      dialect: createOpenCodeDialect(),
      model: "operator-model-id",
      tasksRoot,
    });
    // Regression: with an always-empty readSet the gate interrupted the edit
    // (read-before-edit denial), the host never saw the edit call, and this
    // resolved false with toolInterrupted > 0.
    expect(result.metrics.toolInterrupted).toBe(0);
    expect(result.verify?.passed).toBe(true);
    expect(result.resolved).toBe(true);
  }, 120_000);

  it("forwards only the host's own tools to the model, never bench phantom tools", async () => {
    const task = loadTask(join(tasksRoot, "ts-off-by-one"));
    const inner = new FakeProvider([{
      server: "bench", attempt: "s1", status: 200,
      chunks: READ_THEN_EDIT_CHUNKS, summary: {},
    }]);
    const seen: ChatRequest[] = [];
    const provider = {
      stream: async function* (req: ChatRequest, signal?: AbortSignal) {
        seen.push(req);
        yield* inner.stream(req, signal);
      },
    };
    await runLiveTask(task, {
      host: new ScriptedHostRunner(OPENCODE_TOOLS),
      provider,
      dialect: createOpenCodeDialect(),
      model: "operator-model-id",
      tasksRoot,
    });
    expect(seen.length).toBeGreaterThan(0);
    const names = (seen[0].tools ?? []).map((t) => t.function.name);
    expect(names).toContain("read");
    expect(names).toContain("edit");
    // Regression: makeBenchRegistry's canonical extras were forwarded to the
    // real host as tools it cannot execute (suspected host exitCode 1 cause).
    for (const phantom of ["python", "run", "delete", "apply_patch"]) {
      expect(names).not.toContain(phantom);
    }
  }, 120_000);

  it("writes raw debug artifacts under <debugDir>/<task>-<config>/ when asked", async () => {
    const dbg = mkdtempSync(join(tmpdir(), "bench-dbg-test-"));
    try {
      const task = loadTask(join(tasksRoot, "ts-off-by-one"));
      const result = await runLiveTask(task, {
        host: new ScriptedHostRunner(OPENCODE_TOOLS),
        provider: new FakeProvider([{
          server: "bench", attempt: "s1", status: 200,
          chunks: READ_THEN_EDIT_CHUNKS, summary: {},
        }]),
        dialect: createOpenCodeDialect(),
        model: "operator-model-id",
        tasksRoot,
        debugDir: dbg,
      });
      expect(result.resolved).toBe(true);
      const runDir = join(dbg, "ts-off-by-one-full");
      for (const f of ["host-transcript.jsonl", "proxy-events.jsonl", "patch.diff",
        "verify-output.txt", "workspace-listing.txt"]) {
        expect(existsSync(join(runDir, f)), f).toBe(true);
      }
      expect(readFileSync(join(runDir, "patch.diff"), "utf8")).toContain("sum.js");
      expect(readFileSync(join(runDir, "workspace-listing.txt"), "utf8")).toContain("sum.js");
      expect(readFileSync(join(runDir, "proxy-events.jsonl"), "utf8")).toContain("tool_stream_started");
    } finally {
      rmSync(dbg, { recursive: true, force: true });
    }
  }, 120_000);
});
