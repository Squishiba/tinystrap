import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderInitToml, type InitTomlValues } from "./init-toml.js";

export class ConfigExistsError extends Error {
  readonly path: string;
  constructor(path: string) {
    // Three answers in one message: what happened, why, what to do next.
    super(
      `${path} already exists. tinystrap init never overwrites it. `
      + "Re-run with --force to replace it, or edit the file by hand.",
    );
    this.name = "ConfigExistsError";
    this.path = path;
  }
}

export type WriteInitResult = { path: string; created: boolean; overwritten: boolean };

export function writeInitConfig(opts: {
  projectRoot: string;
  values: InitTomlValues;
  force?: boolean;
}): WriteInitResult {
  const path = join(opts.projectRoot, "tinystrap.toml");
  // The clobber guard. There is exactly one write path and it refuses by default;
  // --force is the only way an existing file is replaced. Refusing (rather than
  // merging) is also what keeps a user's comments intact: no existing file is ever
  // parsed and re-emitted, because smol-toml cannot carry comments through a
  // round trip.
  if (existsSync(path) && !opts.force) throw new ConfigExistsError(path);
  const existed = existsSync(path);
  writeFileSync(path, renderInitToml(opts.values), "utf8");
  return { path, created: !existed, overwritten: existed };
}
