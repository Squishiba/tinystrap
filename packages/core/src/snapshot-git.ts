import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { runGit } from "./git.js";
import { DEFAULT_PATCH_EXCLUDES, matchesPatchExclude } from "./patch.js";
import { isSecretPath } from "./secrets.js";
import type { TaskHandle } from "./taskstore.js";

export type Baseline = {
  taskId: string;
  sourceRoot: string;
  revision: string;
  manifestHash: string;
  trackedChangesHash: string;
  untrackedPolicy: string;
  createdAt: string;
  // Set by snapshotManifest: pristine copy of the workspace tree, used by
  // extractPatch to produce a diff for non-git baselines.
  baselineTreeDir?: string;
};

export async function isGitProject(projectRoot: string): Promise<boolean> {
  const r = await runGit(projectRoot, ["rev-parse", "--git-dir"]);
  return r.code === 0;
}

export async function captureWorkspaceManifestHash(workspaceDir: string): Promise<string> {
  const lines: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === ".git") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else {
        const h = createHash("sha256").update(readFileSync(full)).digest("hex");
        lines.push(`${relative(workspaceDir, full).replace(/\\/g, "/")}\t${h}`);
      }
    }
  };
  walk(workspaceDir);
  lines.sort();
  return `sha256:${createHash("sha256").update(lines.join("\n")).digest("hex")}`;
}

function copyInto(workspaceDir: string, projectRoot: string, rel: string): void {
  const dest = join(workspaceDir, rel);
  mkdirSync(join(dest, ".."), { recursive: true });
  writeFileSync(dest, readFileSync(join(projectRoot, rel)));
}

export async function snapshotGit(
  projectRoot: string,
  handle: TaskHandle,
  opts: { allowIgnoredDirs?: string[]; extraExcludes?: string[] } = {},
): Promise<Baseline> {
  const head = await runGit(projectRoot, ["rev-parse", "HEAD"]);
  if (head.code !== 0) throw new Error(`not a git project: ${head.stderr}`);
  const clone = await runGit(projectRoot,
    ["clone", "--no-hardlinks", projectRoot, handle.workspaceDir]);
  if (clone.code !== 0) throw new Error(`clone failed: ${clone.stderr}`);
  await runGit(handle.workspaceDir, ["remote", "remove", "origin"]);

  const diff = await runGit(projectRoot, ["diff", "HEAD"]);
  const trackedChangesHash = `sha256:${createHash("sha256").update(diff.stdout).digest("hex")}`;
  if (diff.stdout.trim() !== "") {
    const patchFile = join(handle.taskDir, "tracked.diff");
    writeFileSync(patchFile, diff.stdout);
    const applied = await runGit(handle.workspaceDir,
      ["apply", "--whitespace=nowarn", patchFile]);
    if (applied.code !== 0) throw new Error(`apply tracked changes failed: ${applied.stderr}`);
  }

  const excludes = [...DEFAULT_PATCH_EXCLUDES, ...(opts.extraExcludes ?? [])];
  const listed = await runGit(projectRoot, ["ls-files", "--others", "--exclude-standard"]);
  // Generated artifacts (see DEFAULT_PATCH_EXCLUDES) are never copied into the
  // workspace. An explicit allowIgnoredDirs entry below overrides this, so a
  // fixture can still ship e.g. a node_modules directory on purpose.
  const files = listed.stdout.split("\n").filter((f) => f.trim() !== "")
    .filter((f) => !f.endsWith("/"))
    .filter((f) => !f.replace(/\\/g, "/").startsWith(".tinystrap/"))
    .filter((f) => !matchesPatchExclude(f.replace(/\\/g, "/"), excludes))
    .filter((f) => !isSecretPath(f.replace(/\\/g, "/")));
  for (const f of files) copyInto(handle.workspaceDir, projectRoot, f);

  let untrackedPolicy = "include-non-secret-excluding-ignored";
  const allow = opts.allowIgnoredDirs ?? [];
  if (allow.length > 0) {
    for (const dir of allow) {
      const ignored = await runGit(projectRoot,
        ["ls-files", "--others", "-i", "--exclude-standard", "--", dir]);
      for (const f of ignored.stdout.split("\n").filter((x) => x.trim() !== "")) {
        if (f.endsWith("/")) continue;
        if (f.replace(/\\/g, "/").startsWith(".tinystrap/")) continue;
        if (!isSecretPath(f.replace(/\\/g, "/"))) copyInto(handle.workspaceDir, projectRoot, f);
      }
    }
    untrackedPolicy += `; allowlist:${allow.join(",")}`;
  }

  const baseline: Baseline = {
    taskId: handle.taskId,
    sourceRoot: projectRoot,
    revision: `git:${head.stdout.trim()}`,
    manifestHash: await captureWorkspaceManifestHash(handle.workspaceDir),
    trackedChangesHash,
    untrackedPolicy,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(handle.baselinePath, JSON.stringify(baseline, null, 2));
  return baseline;
}
