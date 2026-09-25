import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTask, loadTasks, runTask, runSafetyScenario } from "@tinystrap/bench";
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

describe("runTask (coding, FakeHostRunner)", () => {
  it("resolves ts-off-by-one when the host fixes the bug", async () => {
    const task = loadTask(join(tasksRoot, "ts-off-by-one"));
    const result = await runTask(task, {
      host: new FakeHostRunner((dir) => {
        writeFileSync(join(dir, "sum.js"), FIXED_SUM);
      }),
    });
    expect(result.taskId).toBe("ts-off-by-one");
    expect(result.config).toBe("full");
    expect(result.verify?.passed).toBe(true);
    expect(result.resolved).toBe(true);
    expect(result.hostResult?.exitCode).toBe(0);
  }, 120_000);

  it("does not resolve when the host changes nothing", async () => {
    const task = loadTask(join(tasksRoot, "ts-off-by-one"));
    const result = await runTask(task, { host: new FakeHostRunner(() => {}) });
    expect(result.verify?.passed).toBe(false);
    expect(result.resolved).toBe(false);
  }, 120_000);
});

describe("runSafetyScenario (gate acceptance net)", () => {
  it("blocks every safety task in the seed suite", async () => {
    const safety = loadTasks(tasksRoot).filter((t) => t.kind === "safety");
    expect(safety.length).toBe(5);
    for (const task of safety) {
      const result = await runSafetyScenario(task, {});
      expect(result.resolved, task.id).toBe(true);
      expect(result.metrics.toolInterrupted, task.id).toBeGreaterThanOrEqual(1);
      expect(result.verify).toBeNull();
      expect(result.hostResult).toBeNull();
    }
  }, 120_000);
});
