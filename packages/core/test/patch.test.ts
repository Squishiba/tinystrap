import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createTask, exportPatch, extractPatch, extractPatchDetailed,
  matchesPatchExclude, snapshotGit, snapshotManifest,
} from "@tinystrap/core";

// Git identity via IDENT env vars so no identity flags appear in sources.
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_IDENT: "t <t@t>",
  GIT_COMMITTER_IDENT: "t <t@t>",
};
const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "pipe", env: gitEnv });

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

  it("excludes generated artifacts from a git-baseline patch", async () => {
    const root = mkdtempSync(join(tmpdir(), "ts-patch-ex-"));
    gitIn(root, "init", "-b", "main");
    writeFileSync(join(root, "a.ts"), "one\n");
    gitIn(root, "add", ".");
    gitIn(root, "commit", "-m", "init");
    const h = await createTask(root);
    await snapshotGit(root, h);
    writeFileSync(join(h.workspaceDir, "a.ts"), "two\n");
    mkdirSync(join(h.workspaceDir, "__pycache__"), { recursive: true });
    writeFileSync(join(h.workspaceDir, "__pycache__", "x.cpython-314.pyc"),
      Buffer.from([0xde, 0xc0, 0x00, 0xff]));
    mkdirSync(join(h.workspaceDir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(h.workspaceDir, "node_modules", "pkg", "index.js"), "module.exports = 1\n");
    const patch = await extractPatch(h);
    expect(patch).toContain("a.ts");
    expect(patch).not.toContain("__pycache__");
    expect(patch).not.toContain("node_modules");
    expect(patch).not.toContain("Binary files");
    rmSync(h.taskDir, { recursive: true, force: true });
  });

  it("emits an applicable binary patch and records binary files for genuine binary changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "ts-patch-bin-"));
    gitIn(root, "init", "-b", "main");
    writeFileSync(join(root, "logo.bin"), Buffer.from([1, 2, 0, 255]));
    writeFileSync(join(root, "a.ts"), "one\n");
    gitIn(root, "add", ".");
    gitIn(root, "commit", "-m", "init");
    const h = await createTask(root);
    await snapshotGit(root, h);
    writeFileSync(join(h.workspaceDir, "logo.bin"), Buffer.from([9, 8, 0, 7, 0xfe]));
    const { patch, binaryFiles } = await extractPatchDetailed(h);
    expect(binaryFiles).toContain("logo.bin");
    expect(patch).toContain("GIT binary patch");
    // the patch must apply to a fresh copy with git apply --binary
    const fresh = mkdtempSync(join(tmpdir(), "ts-patch-bin-fresh-"));
    writeFileSync(join(fresh, "logo.bin"), Buffer.from([1, 2, 0, 255]));
    gitIn(fresh, "init", "-b", "main");
    const applied = spawnSync("git", ["apply", "--binary", "-"],
      { cwd: fresh, input: patch, encoding: "utf8" });
    expect(applied.status).toBe(0);
    expect(readFileSync(join(fresh, "logo.bin"))).toEqual(Buffer.from([9, 8, 0, 7, 0xfe]));
    rmSync(h.taskDir, { recursive: true, force: true });
  });

  it("excludes generated artifacts from a manifest-baseline patch", async () => {
    const root = mkdtempSync(join(tmpdir(), "ts-patch-mf-"));
    writeFileSync(join(root, "a.ts"), "one\n");
    const h = await createTask(root);
    await snapshotManifest(root, h);
    writeFileSync(join(h.workspaceDir, "a.ts"), "two\n");
    mkdirSync(join(h.workspaceDir, "__pycache__"), { recursive: true });
    writeFileSync(join(h.workspaceDir, "__pycache__", "x.cpython-314.pyc"),
      Buffer.from([0xde, 0xc0, 0x00, 0xff]));
    mkdirSync(join(h.workspaceDir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(h.workspaceDir, "node_modules", "pkg", "index.js"), "module.exports = 1\n");
    const patch = await extractPatch(h);
    expect(patch).toContain("-one");
    expect(patch).toContain("+two");
    expect(patch).not.toContain("__pycache__");
    expect(patch).not.toContain("node_modules");
    rmSync(h.taskDir, { recursive: true, force: true });
  });

  it("py-factorial regression: a correct text fix survives bytecode-cache pollution", async () => {
    const root = mkdtempSync(join(tmpdir(), "ts-patch-py-"));
    const buggy = "def factorial(n):\n    if n <= 1:\n        return 1\n    return n * factorial(n)\n";
    const fixed = "def factorial(n):\n    if n <= 1:\n        return 1\n    return n * factorial(n - 1)\n";
    gitIn(root, "init", "-b", "main");
    writeFileSync(join(root, "mathx.py"), buggy);
    gitIn(root, "add", ".");
    gitIn(root, "commit", "-m", "init");
    const h = await createTask(root);
    await snapshotGit(root, h);
    // model fixes the bug, then runs python, which drops a .pyc next to the source
    writeFileSync(join(h.workspaceDir, "mathx.py"), fixed);
    mkdirSync(join(h.workspaceDir, "__pycache__"), { recursive: true });
    writeFileSync(join(h.workspaceDir, "__pycache__", "mathx.cpython-314.pyc"),
      Buffer.from([0x0d, 0x0a, 0x00, 0x00, 0xff, 0xfe]));
    const patch = await extractPatch(h);
    expect(patch).not.toContain("__pycache__");
    expect(patch).not.toContain("Binary files");
    const fresh = mkdtempSync(join(tmpdir(), "ts-patch-py-fresh-"));
    writeFileSync(join(fresh, "mathx.py"), buggy);
    gitIn(fresh, "init", "-b", "main");
    const applied = spawnSync("git", ["apply", "--binary", "--whitespace=nowarn", "-"],
      { cwd: fresh, input: patch, encoding: "utf8" });
    expect(applied.status).toBe(0);
    // git apply may normalize line endings per core.autocrlf on Windows
    expect(readFileSync(join(fresh, "mathx.py"), "utf8").replace(/\r\n/g, "\n")).toBe(fixed);
    rmSync(h.taskDir, { recursive: true, force: true });
  });

  it("matchesPatchExclude matches artifacts at any depth and spares normal files", () => {
    expect(matchesPatchExclude("__pycache__/x.cpython-314.pyc", ["__pycache__/"])).toBe(true);
    expect(matchesPatchExclude("pkg/__pycache__/x.pyc", ["__pycache__/"])).toBe(true);
    expect(matchesPatchExclude("a/b.pyc", ["*.pyc"])).toBe(true);
    expect(matchesPatchExclude("node_modules/pkg/index.js", ["node_modules/"])).toBe(true);
    expect(matchesPatchExclude("opencode.json", ["opencode.json"])).toBe(true);
    expect(matchesPatchExclude("src/opened.json", ["opencode.json"])).toBe(false);
    expect(matchesPatchExclude("src/app.py", ["__pycache__/", "*.pyc", "node_modules/"])).toBe(false);
  });
});
