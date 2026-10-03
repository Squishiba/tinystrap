import type { ServerKind } from "@tinystrap/discovery";
import { parse } from "smol-toml";

export type InitTomlValues = {
  baseUrl: string;
  model: string;
  kind: ServerKind;
  contextLength?: number;
  promotionMode?: "apply" | "export_patch" | "commit_task_branch" | "open_pr";
};

// A TOML basic string. The only escaping smol-toml's parser needs for a value that
// came off a server: backslash and double quote.
function q(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// Rendered as text, never produced by parse -> stringify: smol-toml carries no
// comment or ordering metadata, so a round trip would drop every comment below.
// The loader (config.ts:18-22) is the contract these key spellings must match.
export function renderInitToml(values: InitTomlValues): string {
  const lines = [
    "# tinystrap.toml - written by `tinystrap init`.",
    "# The one config file tinystrap reads (spec section 7). Edit it freely:",
    "# `tinystrap init` never rewrites this file unless you pass --force.",
    "",
    "[server]",
    "# Where the model server lives. Discovered on this machine; point it",
    "# somewhere else here if you need to.",
    `base_url = ${q(values.baseUrl)}`,
    `model = ${q(values.model)}`,
    "",
  ];
  if (values.contextLength !== undefined) {
    lines.push(
      "[context]",
      "# Context length (n_ctx) reported by the server for this model.",
      "# Delete this table to fall back to whatever discovery sees at run time.",
      `length = ${values.contextLength}`,
      "",
    );
  }
  lines.push(
    "[promotion]",
    "# apply | export_patch | commit_task_branch | open_pr",
    `mode = ${q(values.promotionMode ?? "apply")}`,
    "",
  );
  const text = lines.join("\n");
  // Fail here, at write time, rather than on the operator's next command.
  parse(text);
  return text;
}
