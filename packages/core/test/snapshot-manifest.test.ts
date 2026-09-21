import { mkdirSync, mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTask, snapshotManifest } from "@tinystrap/core";

describe("manifest snapshot", () => {
  it("copies files with hashed manifest and skips secrets", async () => {
    const root = mkdtempSync(join(tmpdir(), "ts-man-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "a");
    writeFileSync(join(root, ".env"), "S=1");
    const h = await createTask(root);
    const b = await snapshotManifest(root, h);
    expect(b.revision).toMatch(/^manifest:sha256:[0-9a-f]{64}$|^manifest:[0-9a-f]{64}$/);
    expect(existsSync(join(h.workspaceDir, "src", "a.ts"))).toBe(true);
    expect(existsSync(join(h.workspaceDir, ".env"))).toBe(false);
    rmSync(h.taskDir, { recursive: true, force: true });
  });
});
