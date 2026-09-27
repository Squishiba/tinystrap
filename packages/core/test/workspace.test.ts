import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTask, createIndependentCloneProvider } from "@tinystrap/core";

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
