import { describe, expect, it } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTask, loadTasks, verifyInFreshCopy, type BenchTask } from "@tinystrap/bench";

const tasksRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "tasks");

// The harder coding tasks added on top of the ten tier-1 seeds: multi-file
// fixes, a bug that lives in a helper the prompt does not name, and fixes that
// look right but fail a hidden assertion.
// Tasks whose fix has to touch two modules: one bug per file, and the hidden
// tests only go green once both are fixed.
const MULTI_FILE_IDS = ["py-invoice-tax", "py-order-report", "ts-cart-checkout"];

const HARDER_CODING_IDS = [
  "py-invoice-tax",
  "py-order-report",
  "py-settings-bool",
  "ts-cart-checkout",
  "ts-interval-merge",
  "ts-top-scores",
];

describe("harder coding task fixtures", () => {
  it.each(HARDER_CODING_IDS)("%s loads as a resolvable coding task", (id) => {
    const task: BenchTask = loadTask(join(tasksRoot, id));
    expect(task.id).toBe(id);
    expect(task.kind).toBe("coding");
    expect(task.expected).toBe("resolved");
    expect(typeof task.verify === "string" && task.verify.length > 0).toBe(true);
    expect(task.timeoutMs).toBeGreaterThan(0);
    expect(existsSync(join(tasksRoot, id, "fixture"))).toBe(true);
    expect(existsSync(join(tasksRoot, id, "verify"))).toBe(true);
  });

  it.each(MULTI_FILE_IDS)("%s ships a fixture of at least two source files", (id) => {
    expect(readdirSync(join(tasksRoot, id, "fixture")).length).toBeGreaterThanOrEqual(2);
  });

  it("loadTasks picks the new tasks up alongside the seeds", () => {
    const ids = loadTasks(tasksRoot)
      .filter((t) => t.kind === "coding")
      .map((t) => t.id);
    for (const id of HARDER_CODING_IDS) expect(ids).toContain(id);
  });

  // The seeded bug must be a real bug: with an empty patch the hidden tests
  // have to fail, otherwise the task measures nothing.
  it.each(HARDER_CODING_IDS)("%s fails its hidden verifier on the pristine fixture", async (id) => {
    const task = loadTask(join(tasksRoot, id));
    const taskDir = join(tasksRoot, id);
    const result = await verifyInFreshCopy(
      join(taskDir, "fixture"),
      "",
      join(taskDir, "verify"),
      task.verify!,
      60_000,
    );
    expect(result.passed, `${id}: ${result.outputTail}`).toBe(false);
  }, 300_000);

  it("keeps the language tag honest about the fixture's file types", () => {
    for (const id of HARDER_CODING_IDS) {
      const task = loadTask(join(tasksRoot, id));
      const files = readdirSync(join(tasksRoot, id, "fixture"));
      const ext = task.language === "python" ? ".py" : ".js";
      expect(files.every((f) => f.endsWith(ext)), id).toBe(true);
    }
  });
});
