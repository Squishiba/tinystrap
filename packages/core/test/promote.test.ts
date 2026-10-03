import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createTask, promote, snapshotGit,
  type ApproveIO, type CommandRunner, type RunResult, type VerifyReport,
} from "@tinystrap/core";

const PATCH = [
  "diff --git a/a.txt b/a.txt", "--- a/a.txt", "+++ b/a.txt",
  "@@ -1 +1 @@", "-one", "+two", "",
].join("\n");

function passingReport(taskId: string): VerifyReport {
  return { taskId, passed: true, patchHash: "sha256:" + "0".repeat(64),
    apply: { ok: true, outputTail: "" },
    results: [{ name: "check", command: "node check.mjs", exitCode: 0,
      timedOut: false, outputTail: "", durationMs: 1 }],
    startedAt: "", finishedAt: "" };
}

function io(answer: string): ApproveIO & { asked: string[]; printed: string[] } {
  const asked: string[] = []; const printed: string[] = [];
  return { out: (l) => printed.push(l), ask: async (q) => { asked.push(q); return answer; },
    asked, printed };
}

async function snapshotProject() {
  const root = mkdtempSync(join(tmpdir(), "ts-promote-"));
  const GIT_ID = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
  const g = (...a: string[]) => execFileSync("git",
    a, { cwd: root, stdio: "pipe", env: GIT_ID });
  g("init", "-b", "main");
  writeFileSync(join(root, "a.txt"), "one\n");
  g("add", "."); g("commit", "-m", "init");
  const handle = await createTask(root);
  const baseline = await snapshotGit(root, handle);
  return { root, handle, baseline };
}

describe("promote", () => {
  it("refuses an unverified patch without asking", async () => {
    const { root, handle, baseline } = await snapshotProject();
    const io_ = io("y");
    const report = { ...passingReport(handle.taskId), passed: false };
    const r = await promote({ handle, baseline, projectRoot: root, patch: PATCH,
      report, mode: "apply", io: io_ });
    expect(r).toMatchObject({ status: "refused", reason: "not_verified" });
    expect(io_.asked).toHaveLength(0);
  });

  it("denial refuses and changes nothing", async () => {
    const { root, handle, baseline } = await snapshotProject();
    const r = await promote({ handle, baseline, projectRoot: root, patch: PATCH,
      report: passingReport(handle.taskId), mode: "apply", io: io("n") });
    expect(r).toMatchObject({ status: "refused", reason: "approval_denied" });
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("one\n");
  });

  it("apply: approves, checkpoints, applies the exact patch, records events", async () => {
    const { root, handle, baseline } = await snapshotProject();
    const events: string[] = [];
    const r = await promote({ handle, baseline, projectRoot: root, patch: PATCH,
      report: passingReport(handle.taskId), mode: "apply", io: io("y"),
      onEvent: (e) => events.push(e.kind) });
    expect(r).toMatchObject({ status: "applied", postApplyPassed: null });
    // git apply may normalize line endings per core.autocrlf on Windows.
    expect(readFileSync(join(root, "a.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("two\n");
    expect(events).toEqual(["promotion_requested", "promotion_applied"]);
  });

  it("apply refuses on drift AFTER approval, with guidance text", async () => {
    const { root, handle, baseline } = await snapshotProject();
    writeFileSync(join(root, "a.txt"), "human edit\n");   // drift after snapshot
    const r = await promote({ handle, baseline, projectRoot: root, patch: PATCH,
      report: passingReport(handle.taskId), mode: "apply", io: io("y") });
    expect(r).toMatchObject({ status: "refused", reason: "drift" });
    if (r.status === "refused") expect(r.message).toMatch(/re-run|review/i);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("human edit\n");
  });

  it("export_patch needs no approval and writes the patch file", async () => {
    const { root, handle, baseline } = await snapshotProject();
    const io_ = io("n");
    const r = await promote({ handle, baseline, projectRoot: root, patch: PATCH,
      report: passingReport(handle.taskId), mode: "export_patch", io: io_ });
    expect(r.status).toBe("exported");
    expect(io_.asked).toHaveLength(0);
    if (r.status === "exported") expect(readFileSync(r.destPath, "utf8")).toBe(PATCH);
  });

  it("the apply prompt shows the diffstat and the verification summary", async () => {
    const { root, handle, baseline } = await snapshotProject();
    const io_ = io("y");
    await promote({ handle, baseline, projectRoot: root, patch: PATCH,
      report: passingReport(handle.taskId), mode: "apply", io: io_ });
    expect(io_.printed.join("\n")).toMatch(/a\.txt/);       // git apply --stat output
    expect(io_.printed.join("\n")).toMatch(/verified|PASS/i);
  });
});

describe("promote open_pr approval strictness (spec 9.10 hard rules)", () => {
  it("assumeYes does NOT approve a push; the prompt still runs", async () => {
    const { root, handle, baseline } = await snapshotProject();
    const io_ = io("n");
    const r = await promote({ handle, baseline, projectRoot: root, patch: PATCH,
      report: passingReport(handle.taskId), mode: "open_pr", io: io_, assumeYes: true });
    expect(r).toMatchObject({ status: "refused", reason: "approval_denied" });
    expect(io_.asked.join("\n")).toMatch(/Push branch tinystrap\/task-/);
  });

  it("an approved open_pr prompt pushes the named branch via the runner only", async () => {
    const { root, handle, baseline } = await snapshotProject();
    const calls: Array<{ cmd: string; args: string[] }> = [];
    // Fake runner: no network, no real gh. It answers the two reads the drift
    // check makes (rev-parse HEAD, diff HEAD) with the baseline state, fails
    // the branch-existence probe the way git does for a branch that does not
    // exist yet, and plays the remote and gh along.
    const sha = baseline.revision.replace(/^git:/, "");
    const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "", timedOut: false });
    const runner: CommandRunner = async (cmd, args) => {
      const key = `${cmd} ${args.join(" ")}`;
      calls.push({ cmd, args });
      if (key.includes("rev-parse --verify")) return { ...ok(), code: 1 };   // branch is new
      if (key.includes("rev-parse HEAD")) return ok(`${sha}\n`);
      if (key.includes("remote get-url")) return ok("https://example.invalid/acme/project.git\n");
      if (key.includes("pr create")) return ok("https://example.invalid/acme/project/pull/1\n");
      return ok();
    };
    const r = await promote({ handle, baseline, projectRoot: root, patch: PATCH,
      report: passingReport(handle.taskId), mode: "open_pr", io: io("y"), runner });
    expect(r).toMatchObject({ status: "pr_opened",
      prUrl: "https://example.invalid/acme/project/pull/1" });
    const push = calls.find((c) => c.args[0] === "push");
    expect(push?.args).toEqual(["push", "origin",
      `refs/heads/tinystrap/${handle.taskId}:refs/heads/tinystrap/${handle.taskId}`]);
    for (const c of calls) {
      expect(c.args).not.toContain("--force");
      expect(c.args).not.toContain("-f");
    }
  });
});
