import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkDrift, computeProjectFingerprint, createTask, snapshotGit } from "@tinystrap/core";

const GIT_ID = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };

function gitProject(): string {
  const root = mkdtempSync(join(tmpdir(), "ts-drift-"));
  const g = (...a: string[]) => execFileSync("git",
    a, { cwd: root, stdio: "pipe", env: GIT_ID });
  g("init", "-b", "main");
  writeFileSync(join(root, "a.txt"), "one\n");
  g("add", "."); g("commit", "-m", "init");
  return root;
}

describe("drift detection", () => {
  it("no drift right after the snapshot", async () => {
    const root = gitProject();
    const handle = await createTask(root);
    const baseline = await snapshotGit(root, handle);
    expect(await checkDrift(root, baseline)).toEqual({ drifted: false, detail: "" });
  });

  it("a new upstream commit is drift", async () => {
    const root = gitProject();
    const handle = await createTask(root);
    const baseline = await snapshotGit(root, handle);
    writeFileSync(join(root, "b.txt"), "new\n");
    execFileSync("git", ["add", "b.txt"], { cwd: root, stdio: "pipe", env: GIT_ID });
    execFileSync("git", ["commit", "-m", "later"], { cwd: root, stdio: "pipe", env: GIT_ID });
    const d = await checkDrift(root, baseline);
    expect(d.drifted).toBe(true);
    expect(d.detail).toMatch(/new commits since the task started/);
  });

  it("changed uncommitted edits are drift", async () => {
    const root = gitProject();
    const handle = await createTask(root);
    const baseline = await snapshotGit(root, handle);
    writeFileSync(join(root, "a.txt"), "human edit\n");
    const d = await checkDrift(root, baseline);
    expect(d.drifted).toBe(true);
    expect(d.detail).toMatch(/uncommitted changes .* changed/);
  });

  it("fingerprint revision matches the baseline revision format", async () => {
    const root = gitProject();
    const fp = await computeProjectFingerprint(root);
    expect(fp.revision).toMatch(/^git:[0-9a-f]{40}$/);
    expect(fp.trackedChangesHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
