import { resolve } from "node:path";

export type ExitCode = 0 | 1 | 2 | 3 | 4 | 5 | 130;

export type InitFlags = {
  yes: boolean;
  url?: string;
  model?: string;
  dir?: string;
  force: boolean;
  smoke: boolean;
};

export type FlagResult =
  | { ok: true; flags: InitFlags }
  | { ok: false; message: string };

const VALUE_FLAGS: Record<string, "url" | "model" | "dir"> = {
  "--url": "url", "--model": "model", "--dir": "dir",
};
const BOOL_FLAGS: Record<string, "yes" | "force" | "no-smoke"> = {
  "--yes": "yes", "--force": "force", "--no-smoke": "no-smoke",
};

const USAGE = "usage: tinystrap init [--yes] [--url <server-url>] [--model <id>] "
  + "[--dir <project-dir>] [--force] [--no-smoke]";

function usage(problem: string): string { return `${problem}\n${USAGE}`; }

export function parseInitFlags(argv: readonly string[]): FlagResult {
  const flags: InitFlags = { yes: false, force: false, smoke: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const valueFlag = VALUE_FLAGS[arg];
    if (valueFlag !== undefined) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { ok: false, message: usage(`${arg} needs a value.`) };
      }
      i += 1;
      if (valueFlag === "dir") {
        // Resolved here so every later path operation is absolute (Windows-safe:
        // resolve() uses the platform separator, never a hand-built one).
        flags.dir = resolve(value);
      } else if (valueFlag === "url") {
        let parsed: URL;
        try { parsed = new URL(value); } catch {
          return { ok: false, message: usage(`--url is not a valid URL: ${value}`) };
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return { ok: false, message: usage(
            `--url must be http or https, got ${parsed.protocol}`) };
        }
        // A non-loopback URL is allowed on purpose: the operator typed it. Discovery
        // never picks one by itself (local.ts probes loopback only).
        flags.url = value;
      } else {
        flags.model = value;
      }
      continue;
    }
    const boolFlag = BOOL_FLAGS[arg];
    if (boolFlag !== undefined) {
      if (boolFlag === "yes") flags.yes = true;
      else if (boolFlag === "force") flags.force = true;
      else flags.smoke = false;
      continue;
    }
    if (arg.startsWith("-")) return { ok: false, message: usage(`unknown flag: ${arg}`) };
    return { ok: false, message: usage(`unexpected argument: ${arg}`) };
  }
  return { ok: true, flags };
}
