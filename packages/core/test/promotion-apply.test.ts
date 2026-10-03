import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyPatchToProject, commitTaskBranch, createTask } from "@tinystrap/core";

const PATCH = [
  "diff --git a/a.txt b/a.txt", "--- a/a.txt", "+++ b/a.txt",
  "@@ -1 +1 @@", "-one", "+two", "",
].join("\n");

const GIT_ID = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };

function gitProject(): string {
  const root = mkdtempSync(join(tmpdir(), "ts-apply-"));
  const g = (...a: string[]) => execFileSync("git",
    a, { cwd: root, stdio: "pipe", env: GIT_ID });
  g("init", "-b", "main");
  writeFileSync(join(root, "a.txt"), "one\n");
  g("add", "."); g("commit", "-m", "init");
  return root;
}

describe("applyPatchToProject", () => {
  it("applies via stdin and reports success", async () => {
    const root = gitProject();
    const r = await applyPatchToProject(root, PATCH);
    expect(r.code).toBe(0);
    // git apply may normalize line endings per core.autocrlf on Windows.
    expect(readFileSync(join(root, "a.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("two\n");
  });
});

describe("commitTaskBranch", () => {
  it("creates the branch commit without touching the working tree", async () => {
    const root = gitProject();
    const handle = await createTask(root);
    const r = await commitTaskBranch(root, handle, PATCH, "tinystrap/task-0001");
    expect(r.ok).toBe(true);
    // working tree untouched:
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("one\n");
    // branch exists and carries the change:
    const shown = execFileSync("git", ["show", "tinystrap/task-0001:a.txt"],
      { cwd: root, encoding: "utf8" });
    expect(shown.replace(/\r\n/g, "\n")).toBe("two\n");
  });

  it("refuses protected branch names", async () => {
    const root = gitProject();
    const handle = await createTask(root);
    for (const b of ["main", "master"]) {
      const r = await commitTaskBranch(root, handle, PATCH, b);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/protected/);
    }
  });

  it("refuses an existing branch instead of moving it", async () => {
    const root = gitProject();
    const handle = await createTask(root);
    execFileSync("git", ["branch", "taken"], { cwd: root, stdio: "pipe", env: GIT_ID });
    const r = await commitTaskBranch(root, handle, PATCH, "taken");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/already exists/);
  });
});
