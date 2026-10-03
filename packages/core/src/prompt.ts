import type { DiscoveredModel, DiscoveredServer } from "@tinystrap/discovery";

// The entire terminal surface, injected. Nothing here touches process.stdin or
// readline, so every prompt is unit-testable and `--yes` needs no special branch
// in the prompt code - runInit simply supplies an IO whose ask() is never called.
export type PromptIO = {
  out(line: string): void;
  err(line: string): void;
  ask(question: string): Promise<string>;
  isTty: boolean;
};

function numbered(items: readonly string[]): string {
  return items.map((s, i) => `${i + 1}) ${s}`).join("  ");
}

export async function pickServer(
  io: PromptIO, servers: readonly DiscoveredServer[],
): Promise<DiscoveredServer | null> {
  if (servers.length === 0) return null;
  if (servers.length === 1) {
    const s = servers[0];
    io.out(`using server ${s.baseUrl} (${s.kind})`);
    return s;
  }
  io.out("several servers answered:");
  const options = numbered(servers.map((s) => `${s.baseUrl} (${s.kind})`));
  io.out(options);
  // The options ride the question itself, so whatever renders the question shows
  // the operator what they may answer - a bare "which one?" would not.
  const answer = (await io.ask(`which one? ${options}`)).trim();
  const n = Number(answer);
  if (!Number.isInteger(n) || n < 1 || n > servers.length) {
    io.err(`pick one of: ${numbered(servers.map((s) => s.baseUrl))}`);
    return null;
  }
  return servers[n - 1];
}

function modelLine(m: DiscoveredModel): string {
  return m.contextLength === undefined ? m.id : `${m.id} (context ${m.contextLength})`;
}

export async function pickModel(
  io: PromptIO, server: DiscoveredServer, preferred?: string,
): Promise<string | null> {
  const ids = server.models.map((m) => m.id);
  if (preferred !== undefined) {
    if (ids.includes(preferred)) return preferred;
    // Never silently ignore a --model the server cannot serve.
    io.err(`--model ${preferred} is not served by ${server.baseUrl}, which offers: `
      + `${ids.join(", ")}. Pick one of these, or start a server that has it.`);
    return null;
  }
  if (server.models.length === 0) {
    io.err(`server at ${server.baseUrl} responded but listed no models. `
      + "Load a model, or pass --model <id>.");
    return null;
  }
  if (server.models.length === 1) return server.models[0].id;
  io.out("models:");
  const options = numbered(server.models.map(modelLine));
  io.out(options);
  const answer = (await io.ask(`which model? ${options}`)).trim();
  const n = Number(answer);
  if (!Number.isInteger(n) || n < 1 || n > server.models.length) {
    io.err(`pick one of: ${numbered(ids)}`);
    return null;
  }
  return server.models[n - 1].id;
}

export function summarizeChoice(
  io: PromptIO, server: DiscoveredServer, model: string, contextLength?: number,
): void {
  io.out(`server     ${server.baseUrl} (${server.kind})`);
  io.out(`model      ${model}`);
  if (contextLength === undefined) {
    io.out(`context    context length unknown; leaving context.length unset. `
      + "Set [context] length in tinystrap.toml if you know it.");
  } else {
    io.out(`context    ${contextLength}`);
  }
}
