import type { Discovery } from "@tinystrap/discovery";
import { loadConfig, type ResolvedConfig } from "./config.js";

export async function runDoctor(
  projectRoot: string,
  discovery: Discovery,
  cliFlags?: Record<string, unknown>,
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
  return lines.join("\n");
}
