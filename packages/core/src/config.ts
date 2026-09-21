import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import type { DiscoveredValues } from "@tinystrap/discovery";

export type ConfigSource = "builtin" | "user" | "discovered" | "project" | "cli";
export type ConfigEntry = { value: unknown; source: ConfigSource };
export type ResolvedConfig = Record<string, ConfigEntry>;

const BUILTIN: Record<string, unknown> = {
  "server.baseUrl": undefined,
  "server.model": undefined,
  "promotion.mode": "apply",
  "snapshot.allowIgnoredDirs": [],
  "verify.test": undefined,
};

const KEY_MAP: Record<string, string> = {
  base_url: "baseUrl",
  allow_ignored_dirs: "allowIgnoredDirs",
};

function flatten(obj: Record<string, unknown>, prefix: string, out: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(obj)) {
    const key = KEY_MAP[k] ?? k;
    const dotted = prefix ? `${prefix}.${key}` : key;
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      flatten(v as Record<string, unknown>, dotted, out);
    } else {
      out[dotted] = v;
    }
  }
}

function readToml(path: string): Record<string, unknown> {
  try {
    return parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return {};
    throw new Error(`bad TOML in ${path}: ${e.message}`);
  }
}

export async function loadConfig(opts: {
  projectRoot: string;
  userDefaultsPath?: string;
  discovered?: DiscoveredValues;
  cli?: Record<string, unknown>;
}): Promise<ResolvedConfig> {
  const resolved: ResolvedConfig = {};
  const apply = (flat: Record<string, unknown>, source: ConfigSource) => {
    for (const [k, v] of Object.entries(flat)) {
      if (v === undefined) continue;
      resolved[k] = { value: v, source };
    }
  };
  apply(BUILTIN, "builtin");
  if (opts.userDefaultsPath) apply(flattenFile(opts.userDefaultsPath), "user");
  if (opts.discovered) {
    const d = opts.discovered;
    const flat: Record<string, unknown> = {};
    if (d.servers[0]) flat["server.baseUrl"] = d.servers[0].baseUrl;
    if (d.selectedModel) flat["server.model"] = d.selectedModel;
    if (d.contextLength !== undefined) flat["context.length"] = d.contextLength;
    apply(flat, "discovered");
  }
  apply(flattenFile(join(opts.projectRoot, "tinystrap.toml")), "project");
  if (opts.cli) apply(opts.cli, "cli");
  return resolved;
}

function flattenFile(path: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  flatten(readToml(path), "", out);
  return out;
}
