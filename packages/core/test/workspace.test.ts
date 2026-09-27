import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createTask, createIndependentCloneProvider, createExternalWorkspaceProvider,
  extractPatch, openTask,
} from "@tinystrap/core";

function gitProject(): string {
  const root = mkdtempSync(join(tmpdir(), "ts-wsp-"));
  const GIT_ID = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
  const g = (...a: string[]) => execFileSync("git",
    a, { cwd: root, stdio: "pipe", env: GIT_ID });
  g("init", "-b", "main");
  writeFileSync(join(root, "a.txt"), "one\n");
  g("add", "."); g("commit", "-m", "init");
  return root;
}

describe("independent-clone provider", () => {
  it("create snapshots a git project and reports the provider id", async () => {
    const root = gitProject();
    const handle = await createTask(root);
    const provider = createIndependentCloneProvider();
    expect(provider.id).toBe("independent-clone");
    const baseline = await provider.create(handle, root);
    expect(baseline.revision).toMatch(/^git:[0-9a-f]{40}$/);
    expect(existsSync(join(handle.workspaceDir, "a.txt"))).toBe(true);
  });

  it("adopt is not supported by the independent-clone provider", async () => {
    const root = gitProject();
    const handle = await createTask(root);
    await expect(createIndependentCloneProvider().adopt(handle, root))
      .rejects.toThrow(/not supported/);
  });
});

describe("external workspace provider", () => {
  it("adopts a host directory: baseline from its HEAD, patch from its dirty state", async () => {
    const hostDir = gitProject();                       // the AO-style worktree
    const root = mkdtempSync(join(tmpdir(), "ts-wsp-meta-"));  // tinystrap metadata root
    const handle = await createTask(root);
    const provider = createExternalWorkspaceProvider();
    expect(provider.id).toBe("external");

    writeFileSync(join(hostDir, "a.txt"), "two\n");      // host worker edited
    writeFileSync(join(hostDir, "new.txt"), "created\n");
    const baseline = await provider.adopt(handle, hostDir);

    expect(baseline.revision).toMatch(/^git:[0-9a-f]{40}$/);
    expect(baseline.sourceRoot).toBe(hostDir);
    expect(baseline.untrackedPolicy).toContain("external");
    expect(handle.externalWorkspaceDir).toBe(hostDir);

    // openTask re-reads the marker written by adopt:
    const reopened = openTask(root, handle.taskId);
    expect(reopened.externalWorkspaceDir).toBe(hostDir);

    // patch extraction runs against the adopted directory, not taskDir/workspace:
    const patch = await extractPatch(reopened);
    expect(patch).toContain("-one");
    expect(patch).toContain("+two");
    expect(patch).toContain("new.txt");
  });

  it("refuses to adopt a non-git directory with an actionable message", async () => {
    const plain = mkdtempSync(join(tmpdir(), "ts-wsp-plain-"));
    const root = mkdtempSync(join(tmpdir(), "ts-wsp-meta2-"));
    const handle = await createTask(root);
    await expect(createExternalWorkspaceProvider().adopt(handle, plain))
      .rejects.toThrow(/git repository/);
  });
});
