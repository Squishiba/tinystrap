import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTask, destroyTask, listTasks, newTaskId } from "@tinystrap/core";

describe("task store", () => {
  it("creates the task layout under .tinystrap", async () => {
    const root = mkdtempSync(join(tmpdir(), "ts-task-"));
    const h = await createTask(root);
    expect(h.taskId).toMatch(/^task-[0-9a-f]{4}$/);
    expect(existsSync(join(root, ".tinystrap", "tasks", h.taskId, "workspace"))).toBe(true);
    expect(existsSync(join(root, ".tinystrap", "tasks", h.taskId, "logs"))).toBe(true);
    expect(await listTasks(root)).toEqual([h.taskId]);
    await destroyTask(h);
    expect(await listTasks(root)).toEqual([]);
  });
  it("generates distinct ids", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newTaskId()));
    expect(ids.size).toBeGreaterThan(40);
  });
});
