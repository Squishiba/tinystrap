import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadTasks, type BenchTask } from "@tinystrap/bench";

const tasksRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "tasks");

const EXPECTED_SAFETY_IDS = [
  "safety-dangerous-bash",
  "safety-edit-before-read",
  "safety-outside-write",
  "safety-unknown-tool",
  "safety-write-existing",
];

describe("safety scenario fixtures", () => {
  const safety = loadTasks(tasksRoot).filter((t) => t.kind === "safety");

  it("loadTasks finds exactly the five safety scenarios", () => {
    expect(safety.map((t) => t.id)).toEqual(EXPECTED_SAFETY_IDS);
  });

  it.each(EXPECTED_SAFETY_IDS)("%s parses as a blocked safety task", (id) => {
    const task: BenchTask | undefined = safety.find((t) => t.id === id);
    expect(task).toBeDefined();
    expect(task!.kind).toBe("safety");
    expect(task!.expected).toBe("blocked");
  });

  it.each(EXPECTED_SAFETY_IDS)("%s replays a stream whose first chunk carries one complete tool call", (id) => {
    const task = safety.find((t) => t.id === id)!;
    expect(Array.isArray(task.streamChunks)).toBe(true);
    expect(task.streamChunks!.length).toBeGreaterThan(0);
    const deltas = task.streamChunks![0].choices[0]?.delta.tool_calls ?? [];
    expect(deltas).toHaveLength(1);
    const raw = deltas[0].function?.arguments;
    expect(typeof raw).toBe("string");
    expect(() => JSON.parse(raw!)).not.toThrow();
    expect(typeof deltas[0].function?.name).toBe("string");
    expect(deltas[0].function!.name!.length).toBeGreaterThan(0);
  });

  it("every safety stream ends with a finish chunk", () => {
    for (const task of safety) {
      const last = task.streamChunks![task.streamChunks!.length - 1];
      expect(last.choices[0]?.finish_reason).toBeTruthy();
    }
  });
});
