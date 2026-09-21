import { execFileSync } from "node:child_process";
import {
  mkdirSync, mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createTask, isGitProject, snapshotGit } from "@tinystrap/core";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ts-snap-"));
  const g = (...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args],
      { cwd: root, stdio: "pipe" });
  g("init", "-b", "main");
  writeFileSync(join(root, "tracked.txt"), "v1\n");
  g("add", ".");
  g("commit", "-m", "init");
  writeFileSync(join(root, "tracked.txt"), "v2 dirty\n");   // unstaged change
  writeFileSync(join(root, "untracked.txt"), "new\n");       // untracked
  writeFileSync(join(root, ".env"), "SECRET=1\n");           // untracked secret
});

const read = (dir: string, file: string) => readFileSync(join(dir, file), "utf8");

describe("git snapshot", () => {
  it("detects git projects", async () => {
    expect(await isGitProject(root)).toBe(true);
    expect(await isGitProject(mkdtempSync(join(tmpdir(), "ts-plain-")))).toBe(false);
  });
  it("clones independently, carries changes, drops origin, excludes secrets", async () => {
    const h = await createTask(root);
    const b = await snapshotGit(root, h);
    expect(b.revision).toMatch(/^git:[0-9a-f]{40}$/);
    expect(existsSync(join(h.workspaceDir, ".git"))).toBe(true);
    const remotes = execFileSync("git", ["remote"], { cwd: h.workspaceDir, encoding: "utf8" });
    expect(remotes.trim()).toBe("");
    expect(read(h.workspaceDir, "tracked.txt")).toContain("v2 dirty");
    expect(read(h.workspaceDir, "untracked.txt")).toBe("new\n");
    expect(existsSync(join(h.workspaceDir, ".env"))).toBe(false);
    expect(existsSync(h.baselinePath)).toBe(true);
    rmSync(h.taskDir, { recursive: true, force: true });
  });
  it("copies allowlisted ignored dirs", async () => {
    writeFileSync(join(root, ".gitignore"), "node_modules/\n");
    mkdirSync(join(root, "node_modules"), { recursive: true });
    writeFileSync(join(root, "node_modules", "dep.js"), "x");
    const h = await createTask(root);
    const b = await snapshotGit(root, h, { allowIgnoredDirs: ["node_modules"] });
    expect(existsSync(join(h.workspaceDir, "node_modules", "dep.js"))).toBe(true);
    expect(b.untrackedPolicy).toContain("allowlist:node_modules");
    rmSync(h.taskDir, { recursive: true, force: true });
  });
});
