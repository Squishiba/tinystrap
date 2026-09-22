import { describe, expect, it } from "vitest";
import { buildOpenCodeArgs } from "@tinystrap/adapter-opencode";
import type { HostTask } from "@tinystrap/core";

const task: HostTask = {
  taskId: "t1", prompt: "fix the off-by-one", workspaceDir: "C:/ws/t1",
  logsDir: "C:/ws/t1/logs", model: "qwen2.5-coder-7b",
  proxyBaseUrl: "http://127.0.0.1:54321", timeoutMs: 600_000,
};

describe("buildOpenCodeArgs", () => {
  it("builds headless run argv with dir, model, json format, pure", () => {
    const args = buildOpenCodeArgs(task);
    expect(args.slice(0, 2)).toEqual(["run", "--format"]);
    expect(args).toContain("json");
    expect(args).toContain("--pure");
    expect(args[args.indexOf("--dir") + 1]).toBe("C:/ws/t1");
    expect(args[args.indexOf("--model") + 1]).toBe("tinystrap/qwen2.5-coder-7b");
    expect(args.at(-1)).toBe("fix the off-by-one");
  });
  it("never passes --auto (host permissions stay with the harness)", () => {
    expect(buildOpenCodeArgs(task)).not.toContain("--auto");
  });
});