import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRollbackCheckpoint, createTask, restoreFromCheckpoint } from "@tinystrap/core";

const GIT_ID = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };

// Project with a committed a.txt, an UNCOMMITTED human edit to keep.txt (it
// must survive a restore untouched), and a patch that modifies a.txt and
// creates c.txt. The handle is created by the test itself, after setup.
function projectWithPatch(): { root: string; patch: string } {
  const root = mkdtempSync(join(tmpdir(), "ts-ckpt-"));
  const g = (...a: string[]) => execFileSync("git",
    a, { cwd: root, stdio: "pipe", env: GIT_ID });
  g("init", "-b", "main");
  writeFileSync(join(root, "a.txt"), "one\n");
  writeFileSync(join(root, "keep.txt"), "human\n");        // uncommitted human edit survives
  g("add", "."); g("commit", "-m", "init");
  writeFileSync(join(root, "keep.txt"), "human-edited\n");
  // patch: modify a.txt, create c.txt
  const patch = [
    "diff --git a/a.txt b/a.txt",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1 +1 @@",
    "-one",
    "+two",
    "diff --git a/c.txt b/c.txt",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/c.txt",
    "@@ -0,0 +1 @@",
    "+created",
    "",
  ].join("\n");
  return { root, patch };
}

describe("rollback checkpoint", () => {
  it("saves touched files, apply then restore returns the tree byte-for-byte", async () => {
    const { root, patch } = projectWithPatch();
    const handle = await createTask(root);
    const before = readFileSync(join(root, "a.txt"));
    const ckpt = await createRollbackCheckpoint(root, handle, patch);
    expect(existsSync(join(ckpt, "touched.txt"))).toBe(true);

    execFileSync("git", ["apply", "--whitespace=nowarn", "-"],
      { cwd: root, input: patch, stdio: ["pipe", "pipe", "pipe"] });
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("two\n");
    expect(existsSync(join(root, "c.txt"))).toBe(true);

    await restoreFromCheckpoint(root, ckpt);
    expect(readFileSync(join(root, "a.txt"))).toEqual(before);
    expect(existsSync(join(root, "c.txt"))).toBe(false);
    expect(readFileSync(join(root, "keep.txt"), "utf8")).toBe("human-edited\n");
  });
});
