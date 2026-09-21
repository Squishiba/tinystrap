import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/main.js";
import { StubDiscovery } from "@tinystrap/discovery";

const discovery = new StubDiscovery({ servers: [] });

describe("cli", () => {
  it("doctor prints header", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ts-cli-"));
    const out = await runCli(["doctor", "--cwd", dir], discovery);
    expect(out).toContain("tinystrap doctor");
    expect(out).toContain("no servers discovered");
  });
  it("task new creates a task and prints its id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ts-cli-"));
    const out = await runCli(["task", "new", "--cwd", dir]);
    const id = out.trim();
    expect(id).toMatch(/^task-[0-9a-f]{4}$/);
    expect(existsSync(join(dir, ".tinystrap", "tasks", id))).toBe(true);
  });
});
