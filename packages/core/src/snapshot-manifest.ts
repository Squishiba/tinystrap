import { createHash } from "node:crypto";
import {
  copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import type { Baseline } from "./snapshot-git.js";
import { isSecretPath } from "./secrets.js";
import type { TaskHandle } from "./taskstore.js";

export type ManifestEntry = { path: string; sha256: string; size: number };

const SKIP = new Set([".git", ".tinystrap", "node_modules"]);

export async function snapshotManifest(projectRoot: string, handle: TaskHandle): Promise<Baseline> {
  const entries: ManifestEntry[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (SKIP.has(name)) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      const rel = relative(projectRoot, full).replace(/\\/g, "/");
      if (isSecretPath(rel)) continue;
      const hash = createHash("sha256").update(readFileSync(full)).digest("hex");
      entries.push({ path: rel, sha256: hash, size: statSync(full).size });
      const dest = join(handle.workspaceDir, rel);
      mkdirSync(join(dest, ".."), { recursive: true });
      copyFileSync(full, dest);
    }
  };
  walk(projectRoot);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const revision = `manifest:${createHash("sha256")
    .update(entries.map((e) => `${e.path}\t${e.sha256}`).join("\n")).digest("hex")}`;
  const baseline: Baseline = {
    taskId: handle.taskId,
    sourceRoot: projectRoot,
    revision,
    manifestHash: revision,
    trackedChangesHash: "n/a",
    untrackedPolicy: "copy-all-non-secret",
    createdAt: new Date().toISOString(),
  };
  writeFileSync(handle.baselinePath, JSON.stringify(baseline, null, 2));
  return baseline;
}
