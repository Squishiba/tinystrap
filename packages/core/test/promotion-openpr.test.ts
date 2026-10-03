import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createTask, openPullRequest, type CommandRunner, type RunResult,
} from "@tinystrap/core";

type Call = { cmd: string; args: string[] };
const OK: RunResult = { code: 0, stdout: "", stderr: "", timedOut: false };

// Fake runner only — nothing in this file reaches a network or a real gh.
// Unmatched calls succeed, EXCEPT the branch-existence probe, which fails the
// way real git fails for a branch that does not exist (rev-parse --verify
// exits 1): defaulting that to success would make every test report a branch
// that is already taken.
function fakeRunner(responses: Record<string, Partial<RunResult>>): {
  runner: CommandRunner; calls: Call[];
} {
  const calls: Call[] = [];
  const runner: CommandRunner = async (cmd, args) => {
    calls.push({ cmd, args });
    const key = `${cmd} ${args.join(" ")}`;
    for (const [pattern, res] of Object.entries(responses)) {
      if (key.includes(pattern)) return { ...OK, ...res };
    }
    if (key.includes("rev-parse --verify")) {
      return { ...OK, code: 1, stderr: "unknown revision" };
    }
    return OK;
  };
  return { runner, calls };
}

async function handle() {
  return createTask(mkdtempSync(join(tmpdir(), "ts-openpr-")));
}

describe("openPullRequest", () => {
  it("refuses protected branches before running anything", async () => {
    const { runner, calls } = fakeRunner({});
    const r = await openPullRequest("/w/project", await handle(), "patch",
      { branch: "main", runner });
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("refuses when the project has no origin remote", async () => {
    const { runner, calls } = fakeRunner({ "remote get-url": { code: 2, stderr: "no such remote" } });
    const r = await openPullRequest("/w/project", await handle(), "patch",
      { branch: "tinystrap/task-0001", runner });
    expect(r).toMatchObject({ ok: false, stage: "remote" });
    expect(calls.some((c) => c.args.includes("push"))).toBe(false);
  });

  it("pushes exactly the task branch, never force, then calls gh", async () => {
    const { runner, calls } = fakeRunner({
      "remote get-url": { stdout: "https://example.invalid/acme/project.git\n" },
      "pr create": { stdout: "https://example.invalid/acme/project/pull/7\n" },
    });
    const r = await openPullRequest("/w/project", await handle(), "patch",
      { branch: "tinystrap/task-0001", base: "main", title: "T", body: "B", runner });
    expect(r).toEqual({ ok: true, branch: "tinystrap/task-0001",
      prUrl: "https://example.invalid/acme/project/pull/7" });
    const push = calls.find((c) => c.args[0] === "push");
    expect(push?.args).toEqual(["push", "origin", "tinystrap/task-0001:tinystrap/task-0001"]);
    for (const c of calls) {
      expect(c.args).not.toContain("--force");
      expect(c.args).not.toContain("-f");
    }
    const gh = calls.find((c) => c.cmd === "gh");
    expect(gh?.args.slice(0, 2)).toEqual(["pr", "create"]);
    expect(gh?.args).toContain("--head");
    expect(gh?.args).toContain("tinystrap/task-0001");
  });

  it("reports a push failure at the push stage and never reaches gh", async () => {
    const { runner, calls } = fakeRunner({ "push": { code: 1, stderr: "rejected" } });
    const r = await openPullRequest("/w/project", await handle(), "patch",
      { branch: "tinystrap/task-0002", runner });
    expect(r).toMatchObject({ ok: false, stage: "push" });
    expect(calls.some((c) => c.cmd === "gh")).toBe(false);
  });

  it("surfaces a commitTaskBranch failure at the branch stage", async () => {
    const { runner } = fakeRunner({ "rev-parse --verify": { code: 0 } }); // branch exists
    const r = await openPullRequest("/w/project", await handle(), "patch",
      { branch: "tinystrap/task-0003", runner });
    expect(r).toMatchObject({ ok: false, stage: "branch" });
  });
});
