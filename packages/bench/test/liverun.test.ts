import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadTask, runLiveTask, parseBenchLiveArgs, sanitizeRunResult, formatProgressLine,
} from "@tinystrap/bench";
import type { BenchRunResult } from "@tinystrap/bench";
import { FakeProvider } from "@tinystrap/proxy";
import { createOpenCodeDialect } from "@tinystrap/policy";
import type { HostTask, HostRunResult } from "@tinystrap/core";
import { FakeHostRunner } from "./helpers/fakehost.js";

const tasksRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "tasks");

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
    expect(a.out).toBe("some/dir");
    expect(a.label).toBe("small7b");
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
      provider: new FakeProvider([{
        server: "bench", attempt: "unused", status: 200,
        chunks: [{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }], summary: {},
      }]),
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
});
