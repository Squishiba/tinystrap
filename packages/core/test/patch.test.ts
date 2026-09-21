import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTask, exportPatch, extractPatch, snapshotGit } from "@tinystrap/core";

describe("patch extraction", () => {
  it("captures model edits and new files as a patch", async () => {
    const root = mkdtempSync(join(tmpdir(), "ts-patch-"));
    const g = (...a: string[]) => execFileSync("git",
      ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: root, stdio: "pipe" });
    g("init", "-b", "main");
    writeFileSync(join(root, "a.ts"), "one\n");
    g("add", "."); g("commit", "-m", "init");
    const h = await createTask(root);
    await snapshotGit(root, h);
    // simulate model edits inside the workspace:
    writeFileSync(join(h.workspaceDir, "a.ts"), "two\n");
    mkdirSync(join(h.workspaceDir, "new"));
    writeFileSync(join(h.workspaceDir, "new", "b.ts"), "created\n");
    const patch = await extractPatch(h);
    expect(patch).toContain("-one");
    expect(patch).toContain("+two");
    expect(patch).toContain("new/b.ts");
    expect(existsSync(h.patchPath)).toBe(true);
    const dest = join(root, "out.patch");
    await exportPatch(h, dest);
    expect(readFileSync(dest, "utf8")).toBe(patch);
    rmSync(h.taskDir, { recursive: true, force: true });
  });
});
