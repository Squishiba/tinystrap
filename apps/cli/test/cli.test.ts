import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli, formatVerifyReport } from "../src/main.js";
import { StubDiscovery } from "@tinystrap/discovery";

const discovery = new StubDiscovery({ servers: [] });

const GIT_ID = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };

// git checkout normalises line endings per core.autocrlf on Windows.
const read = (p: string): string => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

// A real git project whose committed baseline carries the check script, plus a
// [verify] override so the resolved command is a plain `node` run: the detected
// shape for a package.json test script is `pnpm run test`, and a package
// manager in a CI test could reach the network. Detection supplies the name,
// the override supplies the command (spec 7).
async function verifiedProject(
  opts: { promotionMode?: string } = {},
): Promise<{ dir: string; id: string }> {
  const dir = mkdtempSync(join(tmpdir(), "ts-cli-verify-"));
  const g = (...a: string[]) => execFileSync("git", a,
    { cwd: dir, stdio: "pipe", env: GIT_ID });
  g("init", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "one\n");
  writeFileSync(join(dir, "check.mjs"),
    "import { readFileSync } from 'node:fs';\n"
    + "process.exit(readFileSync('a.txt', 'utf8').replace(/\\r\\n/g, '\\n') === 'two\\n' ? 0 : 1);\n");
  writeFileSync(join(dir, "tinystrap.toml"),
    '[verify]\ntest = "node check.mjs"\n'
    + (opts.promotionMode ? `[promotion]\nmode = "${opts.promotionMode}"\n` : ""));
  g("add", "."); g("commit", "-m", "init");
  const id = (await runCli(["task", "new", "--cwd", dir])).trim();
  return { dir, id };
}

// Where the model's edits live for the default (independent-clone) provider.
const workspaceFile = (dir: string, id: string, rel: string): string =>
  join(dir, ".tinystrap", "tasks", id, "workspace", rel);

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

describe("task verify", () => {
  it("passes when the workspace edit satisfies the resolved check", async () => {
    const { dir, id } = await verifiedProject();
    writeFileSync(workspaceFile(dir, id, "a.txt"), "two\n");
    const out = await runCli(["task", "verify", id, "--cwd", dir]);
    expect(out).toContain(`${id}: PASS`);
    expect(out).toContain("test");
    expect(out).toContain("node check.mjs");
  }, 60_000);

  it("fails with an actionable error when the check fails", async () => {
    const { dir, id } = await verifiedProject();
    writeFileSync(workspaceFile(dir, id, "a.txt"), "wrong\n");
    const err = await runCli(["task", "verify", id, "--cwd", dir]).catch((e) => e as Error);
    expect((err as Error).message).toMatch(/FAIL/);
    expect((err as Error).message).toMatch(/did not pass verification/);
    expect((err as Error).message).toContain(`tinystrap task export ${id}`);
  }, 60_000);

  it("refuses to verify a task that does not exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ts-cli-verify-"));
    await expect(runCli(["task", "verify", "task-0000", "--cwd", dir]))
      .rejects.toThrow(/no such task/);
  });

  it("asks for the task id when none is given", async () => {
    await expect(runCli(["task", "verify"])).rejects.toThrow(/usage/);
  });
});

describe("formatVerifyReport", () => {
  it("renders the summary line, the failing check, and its output tail", () => {
    const text = formatVerifyReport({
      taskId: "task-1", passed: false, patchHash: `sha256:${"a".repeat(64)}`,
      apply: { ok: true, outputTail: "" },
      results: [{ name: "test", command: "node check.mjs", exitCode: 1, timedOut: false,
        outputTail: "expected two\n", durationMs: 12 }],
      startedAt: "", finishedAt: "",
    });
    expect(text).toContain("task-1: FAIL (1 checks,");
    expect(text).toContain("test  node check.mjs  exit 1");
    expect(text).toContain("| expected two");
  });

  it("says why nothing ran when the patch did not apply", () => {
    const text = formatVerifyReport({
      taskId: "task-1", passed: false, patchHash: `sha256:${"b".repeat(64)}`,
      apply: { ok: false, outputTail: "error: patch does not apply\n" },
      results: [], startedAt: "", finishedAt: "",
    });
    expect(text).toContain("patch did not apply");
    expect(text).toContain("error: patch does not apply");
  });
});
