// Task format on disk.
//
// packages/bench/tasks/<task-id>/
//   task.json      # the BenchTask fields below (no id duplication: dir name must equal id)
//   fixture/       # tiny repo the model sees (coding tasks only)
//   verify/        # hidden files copied into the fresh copy AFTER the patch (coding tasks only)

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import type { StreamChunk } from "@tinystrap/proxy";

export type BenchTask = {
  id: string;
  kind: "coding" | "safety";
  language: string; // "typescript" | "python" | "any"
  prompt: string; // coding: the instruction for the host
  verify?: string; // coding: command run in the fresh copy
  expected: "resolved" | "blocked";
  streamChunks?: StreamChunk[]; // safety: recorded model turn to replay
  forbiddenPath?: string; // safety: must NOT exist after the run
  timeoutMs: number;
};

const KINDS = ["coding", "safety"] as const;

export function loadTask(taskDir: string): BenchTask {
  const raw = JSON.parse(readFileSync(join(taskDir, "task.json"), "utf8")) as Record<string, unknown>;
  const id = basename(taskDir);

  const kind = raw.kind;
  if (kind !== "coding" && kind !== "safety") {
    throw new Error(`task ${id}: unknown kind ${JSON.stringify(kind)}`);
  }
  if (raw.id !== undefined && raw.id !== id) {
    throw new Error(`task ${id}: id field ${JSON.stringify(raw.id)} does not match directory name`);
  }
  if (typeof raw.language !== "string") {
    throw new Error(`task ${id}: language must be a string`);
  }
  if (typeof raw.prompt !== "string") {
    throw new Error(`task ${id}: prompt must be a string`);
  }
  if (typeof raw.timeoutMs !== "number") {
    throw new Error(`task ${id}: timeoutMs must be a number`);
  }
  if (raw.expected !== "resolved" && raw.expected !== "blocked") {
    throw new Error(`task ${id}: expected must be "resolved" or "blocked"`);
  }
  const expected: BenchTask["expected"] = raw.expected;

  if (kind === "coding") {
    if (!existsSync(join(taskDir, "fixture"))) {
      throw new Error(`task ${id}: coding task is missing fixture/`);
    }
    if (raw.verify !== undefined && typeof raw.verify !== "string") {
      throw new Error(`task ${id}: verify must be a string`);
    }
  }
  if (kind === "safety" && expected === "blocked") {
    if (!Array.isArray(raw.streamChunks)) {
      throw new Error(`task ${id}: blocked safety task requires streamChunks`);
    }
  }

  const task: BenchTask = {
    id,
    kind,
    language: raw.language,
    prompt: raw.prompt,
    expected,
    timeoutMs: raw.timeoutMs,
  };
  if (typeof raw.verify === "string") task.verify = raw.verify;
  if (Array.isArray(raw.streamChunks)) task.streamChunks = raw.streamChunks as StreamChunk[];
  if (typeof raw.forbiddenPath === "string") task.forbiddenPath = raw.forbiddenPath;
  return task;
}

export function loadTasks(tasksRoot: string): BenchTask[] {
  const tasks: BenchTask[] = [];
  for (const entry of readdirSync(tasksRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(tasksRoot, entry.name);
    if (!existsSync(join(dir, "task.json"))) continue;
    tasks.push(loadTask(dir));
  }
  return tasks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
