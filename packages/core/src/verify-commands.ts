// Verify-command auto-detection (spec 9.9). Detection order is stable and
// puts the most informative check first. Commands are plain `program args`
// strings; the verifier refuses anything a shell would interpret.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ResolvedConfig } from "./config.js";

export type VerifyCommand = { name: string; command: string };

const NPM_SCRIPTS = ["test", "lint", "typecheck", "build"] as const;

export function detectVerifyCommands(projectRoot: string): VerifyCommand[] {
  const out: VerifyCommand[] = [];
  const pkgPath = join(projectRoot, "package.json");
  if (existsSync(pkgPath)) {
    let scripts: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: unknown };
      if (parsed.scripts && typeof parsed.scripts === "object") {
        scripts = parsed.scripts as Record<string, unknown>;
      }
    } catch { /* malformed package.json: skip, other ecosystems still count */ }
    for (const name of NPM_SCRIPTS) {
      if (typeof scripts[name] === "string") out.push({ name, command: `pnpm run ${name}` });
    }
  }
  if (existsSync(join(projectRoot, "pytest.ini")) || existsSync(join(projectRoot, "conftest.py"))
    || (existsSync(join(projectRoot, "pyproject.toml"))
        && readFileSync(join(projectRoot, "pyproject.toml"), "utf8").includes("[tool.pytest"))) {
    out.push({ name: "pytest", command: "pytest" });
  }
  if (existsSync(join(projectRoot, "Cargo.toml"))) out.push({ name: "cargo", command: "cargo test" });
  if (existsSync(join(projectRoot, "go.mod"))) out.push({ name: "go", command: "go test ./..." });
  const makefile = join(projectRoot, "Makefile");
  if (existsSync(makefile) && /^test:/m.test(readFileSync(makefile, "utf8"))) {
    out.push({ name: "make", command: "make test" });
  }
  return out;
}

// Spec 7: "[verify] commands auto-detected; override any subset".
// A string override replaces the detected command of the same name (or adds
// a new one); the empty string disables a detected command (the recommended
// off-switch — TOML has no undefined). Non-string values are ignored so a
// stray `verify.test = false` cannot smuggle a non-command into the runner.
export function resolveVerifyCommands(
  detected: VerifyCommand[],
  overrides: Record<string, unknown>,
): VerifyCommand[] {
  const byName = new Map(detected.map((c) => [c.name, c]));
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value !== "string") continue;
    if (value.trim() === "") { byName.delete(key); continue; }
    byName.set(key, { name: key, command: value });
  }
  return [...byName.values()];
}

export function verifyOverridesFromConfig(config: ResolvedConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(config)) {
    if (key.startsWith("verify.")) out[key.slice("verify.".length)] = entry.value;
  }
  return out;
}
