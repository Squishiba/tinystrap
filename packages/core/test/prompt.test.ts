import { describe, expect, it } from "vitest";
import { pickModel, pickServer, summarizeChoice } from "@tinystrap/core";
import type { PromptIO } from "@tinystrap/core";
import type { DiscoveredServer } from "@tinystrap/discovery";

// The whole point of PromptIO: a test supplies the terminal. No readline, no TTY.
function fakeIO(answers: string[] = []): PromptIO & { lines: string[]; errors: string[]; asked: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  const asked: string[] = [];
  const queue = [...answers];
  return {
    lines, errors, asked, isTty: true,
    out: (l) => { lines.push(l); },
    err: (l) => { errors.push(l); },
    ask: async (q) => { asked.push(q); return queue.shift() ?? ""; },
  };
}

const a: DiscoveredServer = { baseUrl: "http://127.0.0.1:8080", kind: "llamacpp",
  models: [{ id: "m-a", contextLength: 8192 }] };
const b: DiscoveredServer = { baseUrl: "http://127.0.0.1:1234", kind: "openai-compatible",
  models: [{ id: "m-b" }] };

describe("init prompts", () => {
  it("zero input: one server and one model are taken without asking", async () => {
    const io = fakeIO();
    expect(await pickServer(io, [a])).toBe(a);
    expect(await pickModel(io, a)).toBe("m-a");
    expect(io.asked).toEqual([]);
  });
  it("no server is a null, not a throw", async () => {
    expect(await pickServer(fakeIO(), [])).toBeNull();
  });
  it("asks only when there is a real choice, and validates the answer", async () => {
    const io = fakeIO(["2"]);
    expect(await pickServer(io, [a, b])).toBe(b);
    expect(io.asked[0]).toContain("1)");
    expect(io.asked[0]).toContain("2)");
  });
  it("an out-of-range answer reports the options and returns null", async () => {
    const io = fakeIO(["9"]);
    expect(await pickServer(io, [a, b])).toBeNull();
    expect(io.errors[0]).toContain("1)");
    expect(io.errors[0]).toContain("2)");
  });
  it("--model is accepted when the server serves it", async () => {
    const io = fakeIO();
    expect(await pickModel(io, a, "m-a")).toBe("m-a");
    expect(io.asked).toEqual([]);
  });
  it("--model the server does not serve names what it does serve", async () => {
    const io = fakeIO();
    expect(await pickModel(io, a, "nope")).toBeNull();
    expect(io.errors[0]).toContain("is not served by");
    expect(io.errors[0]).toContain("m-a");
  });
  it("an unknown context length is stated, not invented", () => {
    const io = fakeIO();
    summarizeChoice(io, b, "m-b");
    expect(io.lines.join("\n")).toContain("context length unknown");
  });
});
