import { randomBytes } from "node:crypto";
import {
  copyFileSync, cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { runGit } from "./git.js";
import type { TaskHandle } from "./taskstore.js";

// Generated/cache artifacts must never enter an extracted patch. A bench run
// proved why: the model fixed a .py file correctly, but running python during
// the run dropped __pycache__/*.pyc into the workspace; `git add -A` staged it,
// the patch carried it as "Binary files ... differ" with no full index line,
// and the fresh-copy verifier could not apply the patch, scoring a correct
// solution as a failure. The same applies to node_modules, test caches, venvs,
// coverage output, and the harness's own files (.tinystrap/, opencode.json).
// Callers can extend this list via the extraExcludes option on extractPatch,
// snapshotGit and snapshotManifest.
export const DEFAULT_PATCH_EXCLUDES: readonly string[] = [
  "__pycache__/", "*.pyc", "*.pyo", ".pytest_cache/", ".mypy_cache/",
  ".ruff_cache/", "node_modules/", ".venv/", "venv/", "*.egg-info/",
  ".tox/", "coverage/", ".DS_Store", "Thumbs.db", ".tinystrap/", "opencode.json",
];

export type PatchExtractionOptions = { extraExcludes?: string[] };
export type PatchExtractionResult = { patch: string; binaryFiles: string[] };

function globToRegExp(pattern: string): RegExp {
  const src = pattern
    .split("*")
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  return new RegExp(`^${src}$`);
}

// A pattern matches a relative path when the whole path equals it, or when any
// path segment matches it (trailing "/" patterns match directory segments,
// "*.pyc"-style patterns glob a single segment). Matching at any depth keeps
// "__pycache__/" from leaking through nested packages.
export function matchesPatchExclude(relPath: string, patterns: readonly string[]): boolean {
  const rel = relPath.replace(/\\/g, "/");
  const segments = rel.split("/");
  for (const raw of patterns) {
    const pattern = raw.replace(/\\/g, "/");
    if (pattern === "") continue;
    if (rel === pattern) return true;
    const re = globToRegExp(pattern.endsWith("/") ? pattern.slice(0, -1) : pattern);
    if (segments.some((s) => re.test(s))) return true;
  }
  return false;
}

function gitExcludePathspec(pattern: string): string {
  const p = pattern.replace(/\\/g, "/").replace(/\/$/, "");
  // "**/" matches zero or more leading directories in git's glob pathspec.
  return pattern.endsWith("/") ? `:(exclude,glob)**/${p}/**` : `:(exclude,glob)**/${p}`;
}

function collectBinaryFiles(numstat: string): string[] {
  const binaries: string[] = [];
  for (const line of numstat.split("\n")) {
    if (line.trim() === "") continue;
    const parts = line.split("\t");
    if (parts[0] === "-" && parts[1] === "-") binaries.push(parts.slice(2).join("\t"));
  }
  return binaries;
}

// Binary policy: patches are NOT text-only. We emit `git diff --binary` so a
// genuinely modified binary (e.g. an image the task asked to change) round
// trips through `git apply --binary` in the verifier, and we report the binary
// paths in the extraction result so callers can flag or reject them. The
// py-factorial failure mode is handled separately: generated artifacts never
// reach the diff at all, per DEFAULT_PATCH_EXCLUDES above.
async function extractGitPatch(
  handle: TaskHandle,
  rev: string,
  excludes: readonly string[],
): Promise<PatchExtractionResult> {
  const tmpIndex = join(handle.taskDir, "tmp.index");
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  // Seed the index from the baseline commit so tracked files that match an
  // exclusion stay at their baseline state instead of showing as deletions.
  const seed = await runGit(handle.workspaceDir, ["read-tree", rev], { env });
  if (seed.code !== 0) throw new Error(`patch index seed failed: ${seed.stderr}`);
  const add = await runGit(handle.workspaceDir,
    ["add", "-A", "--", ".", ...excludes.map(gitExcludePathspec)], { env });
  if (add.code !== 0) throw new Error(`patch add failed: ${add.stderr}`);
  const diff = await runGit(handle.workspaceDir, ["diff", "--cached", "--binary", rev], { env });
  if (diff.code !== 0) throw new Error(`patch diff failed: ${diff.stderr}`);
  const numstat = await runGit(handle.workspaceDir,
    ["diff", "--cached", "--numstat", rev], { env });
  if (numstat.code !== 0) throw new Error(`patch numstat failed: ${numstat.stderr}`);
  return { patch: diff.stdout, binaryFiles: collectBinaryFiles(numstat.stdout) };
}

// Manifest baselines have no git history to diff against, so snapshotManifest
// keeps a pristine copy of the workspace under taskDir/baseline-tree. We
// replay both trees into a scratch repo (index only, no commit, so no git
// identity is required) and diff the baseline tree against the current
// workspace, applying the same exclusions to the workspace side.
async function extractManifestPatch(
  handle: TaskHandle,
  baselineTreeDir: string,
  excludes: readonly string[],
): Promise<PatchExtractionResult> {
  const scratch = join(handle.taskDir, `extract-${randomBytes(4).toString("hex")}`);
  try {
    cpSync(baselineTreeDir, scratch, { recursive: true });
    const init = await runGit(scratch, ["init", "-q"]);
    if (init.code !== 0) throw new Error(`patch scratch init failed: ${init.stderr}`);
    const add0 = await runGit(scratch, ["add", "-A"]);
    if (add0.code !== 0) throw new Error(`patch baseline add failed: ${add0.stderr}`);
    const tree = await runGit(scratch, ["write-tree"]);
    if (tree.code !== 0) throw new Error(`patch baseline tree failed: ${tree.stderr}`);
    const baseTree = tree.stdout.trim();
    for (const entry of readdirSync(scratch)) {
      if (entry === ".git") continue;
      rmSync(join(scratch, entry), { recursive: true, force: true });
    }
    // Stage the workspace state in a separate index seeded from baseTree via
    // read-tree. Reusing the index written by the baseline add would let
    // git's stat cache skip a replaced file whose size and mtime-second match
    // the baseline entry (a same-second rewrite of a same-size file), which
    // silently produces an empty diff. read-tree entries carry no stat info,
    // so the next add always re-hashes the actual content.
    const wsIndex = join(handle.taskDir, `ws-${randomBytes(4).toString("hex")}.index`);
    const wsEnv = { ...process.env, GIT_INDEX_FILE: wsIndex };
    const seed = await runGit(scratch, ["read-tree", baseTree], { env: wsEnv });
    if (seed.code !== 0) throw new Error(`patch workspace index seed failed: ${seed.stderr}`);
    const copyIntoScratch = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (entry === ".git") continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) { copyIntoScratch(full); continue; }
        const rel = relative(handle.workspaceDir, full).replace(/\\/g, "/");
        if (matchesPatchExclude(rel, excludes)) continue;
        const dest = join(scratch, rel);
        mkdirSync(join(dest, ".."), { recursive: true });
        copyFileSync(full, dest);
      }
    };
    copyIntoScratch(handle.workspaceDir);
    const add1 = await runGit(scratch, ["add", "-A"], { env: wsEnv });
    if (add1.code !== 0) throw new Error(`patch workspace add failed: ${add1.stderr}`);
    const diff = await runGit(scratch, ["diff", "--cached", "--binary", baseTree], { env: wsEnv });
    if (diff.code !== 0) throw new Error(`patch diff failed: ${diff.stderr}`);
    const numstat = await runGit(scratch, ["diff", "--cached", "--numstat", baseTree], { env: wsEnv });
    if (numstat.code !== 0) throw new Error(`patch numstat failed: ${numstat.stderr}`);
    return { patch: diff.stdout, binaryFiles: collectBinaryFiles(numstat.stdout) };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export async function extractPatchDetailed(
  handle: TaskHandle,
  opts: PatchExtractionOptions = {},
): Promise<PatchExtractionResult> {
  const baseline = JSON.parse(readFileSync(handle.baselinePath, "utf8")) as
    { revision: string; baselineTreeDir?: string };
  const excludes = [...DEFAULT_PATCH_EXCLUDES, ...(opts.extraExcludes ?? [])];
  let result: PatchExtractionResult;
  if (baseline.revision.startsWith("git:")) {
    result = await extractGitPatch(handle, baseline.revision.replace(/^git:/, ""), excludes);
  } else if (baseline.revision.startsWith("manifest:")) {
    if (!baseline.baselineTreeDir) {
      throw new Error("manifest baseline has no baseline tree; re-snapshot with this version");
    }
    result = await extractManifestPatch(handle, baseline.baselineTreeDir, excludes);
  } else {
    throw new Error(`unsupported baseline revision: ${baseline.revision}`);
  }
  writeFileSync(handle.patchPath, result.patch);
  return result;
}

export async function extractPatch(
  handle: TaskHandle,
  opts: PatchExtractionOptions = {},
): Promise<string> {
  const { patch } = await extractPatchDetailed(handle, opts);
  return patch;
}

export async function exportPatch(handle: TaskHandle, destPath: string): Promise<void> {
  copyFileSync(handle.patchPath, destPath);
}
