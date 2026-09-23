import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTask, loadTasks, type BenchTask } from "@tinystrap/bench";

let root: string;

function makeTask(dir: string, task: object, opts: { fixture?: boolean } = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "task.json"), JSON.stringify(task));
  if (opts.fixture !== false) mkdirSync(join(dir, "fixture"), { recursive: true });
}

const codingTask = {
  kind: "coding",
  language: "typescript",
  prompt: "fix the bug",
  verify: "node verify/check.js",
  expected: "resolved",
  timeoutMs: 60000,
};

const safetyTask = {
  kind: "safety",
  language: "any",
  prompt: "do the thing",
  expected: "blocked",
  streamChunks: [{ content: "hi" }],
  timeoutMs: 30000,
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "bench-taskfile-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("loadTask", () => {
  it("parses a valid coding task from disk", () => {
    const dir = join(root, "alpha-task");
    makeTask(dir, codingTask);
    mkdirSync(join(dir, "fixture"), { recursive: true });
    writeFileSync(join(dir, "fixture", "a.txt"), "hello");
    const task: BenchTask = loadTask(dir);
    expect(task.id).toBe("alpha-task");
    expect(task.kind).toBe("coding");
    expect(task.prompt).toBe("fix the bug");
    expect(task.verify).toBe("node verify/check.js");
    expect(task.expected).toBe("resolved");
    expect(task.timeoutMs).toBe(60000);
  });

  it("throws when a coding task has no fixture/", () => {
    const dir = join(root, "no-fixture");
    makeTask(dir, codingTask, { fixture: false });
    expect(() => loadTask(dir)).toThrow(/fixture/);
  });

  it("throws when a blocked safety task has no streamChunks", () => {
    const dir = join(root, "no-stream");
    makeTask(dir, { ...safetyTask, streamChunks: undefined });
    expect(() => loadTask(dir)).toThrow(/streamChunks/);
  });

  it("throws when the dir name does not equal id", () => {
    const dir = join(root, "dir-name");
    makeTask(dir, { ...codingTask, id: "other-name" });
    expect(() => loadTask(dir)).toThrow(/id/);
  });

  it("throws on unknown kind", () => {
    const dir = join(root, "weird-kind");
    makeTask(dir, { ...codingTask, kind: "mystery" });
    expect(() => loadTask(dir)).toThrow(/kind/);
  });
});

describe("loadTasks", () => {
  it("loads every task.json under the root, sorted by id", () => {
    const tasksRoot = join(root, "tasks");
    makeTask(join(tasksRoot, "zeta"), codingTask);
    makeTask(join(tasksRoot, "alpha"), { ...safetyTask, kind: "safety" });
    mkdirSync(join(tasksRoot, "not-a-task"), { recursive: true });
    const tasks = loadTasks(tasksRoot);
    expect(tasks.map((t) => t.id)).toEqual(["alpha", "zeta"]);
  });
});
