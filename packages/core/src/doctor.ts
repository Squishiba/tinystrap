import type { Discovery } from "@tinystrap/discovery";
import { loadConfig, type ResolvedConfig } from "./config.js";
import { detectVerifyCommands } from "./verify-commands.js";

export type DoctorExtra = {
  // The CLI injects this (it wraps proxy's selectProfile). `core` must NOT import
  // @tinystrap/proxy at runtime, so the resolver arrives as a callback.
  resolveProfile?: (modelId: string) => string | undefined;
};

export async function runDoctor(
  projectRoot: string,
  discovery: Discovery,
  cliFlags?: Record<string, unknown>,
  extra?: DoctorExtra,
): Promise<string> {
  let discovered;
  let discoveryError: string | undefined;
  try {
    discovered = await discovery.probe();
  } catch (err) {
    discoveryError = (err as Error).message;
  }
  const config: ResolvedConfig = await loadConfig({
    projectRoot, discovered, cli: cliFlags,
  });
  const lines = ["tinystrap doctor"];
  for (const key of Object.keys(config).sort()) {
    const e = config[key];
    const value = typeof e.value === "string" ? e.value : JSON.stringify(e.value);
    lines.push(`${key} = ${value}   (${e.source})`);
  }
  lines.push("");
  if (discoveryError) {
    lines.push(`discovery failed: ${discoveryError}`);
  } else if (discovered && discovered.servers.length > 0) {
    lines.push("discovered servers:");
    for (const s of discovered.servers) {
      lines.push(`  ${s.kind} ${s.baseUrl} models=${s.models.map((m) => m.id).join(",")}`);
    }
  } else {
    lines.push("no servers discovered");
  }
  // Spec section 8/14: a failed probe must say which endpoints were tried and what
  // each returned. Only rendered when discovery reported attempts, so the output of
  // every existing doctor call is byte-identical to before.
  if (discovered?.attempts && discovered.attempts.length > 0) {
    lines.push("probe attempts:");
    for (const a of discovered.attempts) {
      lines.push(`  ${a.outcome}  ${a.url}  (${a.status ?? a.detail ?? "-"})`);
    }
  }
  const model = discovered?.selectedModel
    ?? config["server.model"]?.value;
  if (extra?.resolveProfile && typeof model === "string") {
    const name = extra.resolveProfile(model);
    // Spec section 12.1: doctor shows the selected profile and why.
    if (name) lines.push(`profile = ${name}   (profile)`);
  }
  // Spec section 8.1: the operator sees which checks the verifier would run in a
  // fresh copy of the baseline, and where to override them, before running a task.
  const verifyCommands = detectVerifyCommands(projectRoot);
  lines.push("");
  if (verifyCommands.length === 0) {
    lines.push("verify commands: none detected (configure [verify] in tinystrap.toml)");
  } else {
    lines.push("verify commands:");
    for (const c of verifyCommands) lines.push(`  ${c.name} = ${c.command}`);
  }
  return lines.join("\n");
}
