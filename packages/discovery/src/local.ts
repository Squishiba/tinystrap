import type { Discovery, DiscoveredValues, ProbeAttempt } from "./index.js";

// Loopback-only discovery policy. `init` must work with zero input, so the port
// list is fixed and loopback-only; a non-loopback address is reachable ONLY when the
// operator supplies it as `--url` (Task 9), never as a default.
export const LOCAL_PORTS: readonly number[] = [8080, 11434, 1234];

// Same three hostnames adapters/opencode/src/config.ts:12 already accepts. WHATWG
// URL keeps IPv6 literals bracketed, hence the "[::1]" spelling.
export function isLoopbackUrl(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  return u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
}

export function localTargets(ports: readonly number[] = LOCAL_PORTS): string[] {
  return ports.map((p) => `http://127.0.0.1:${p}`);
}

export type ProbeFetch =
  (url: string) => Promise<{ status: number; json(): Promise<unknown> }>;

// Structurally identical to llamacpp.ts's unexported FetchLike, so a double written
// for either satisfies the other.
const defaultProbeFetch: ProbeFetch = async (url) => {
  const res = await fetch(url);
  return { status: res.status, json: () => res.json() as Promise<unknown> };
};

// Spec section 14: doctor must explain exactly which endpoints were probed and what
// each returned. One line, comma separated, no internal type names.
export function describeAttempts(attempts: readonly ProbeAttempt[]): string {
  const body = attempts
    .map((a) => `${a.url} (${a.status ?? a.detail ?? a.outcome})`)
    .join(", ");
  return body ? `probed: ${body}` : "probed nothing";
}

async function attempt(
  fetchImpl: ProbeFetch, url: string,
): Promise<{ attempt: ProbeAttempt; body: unknown }> {
  try {
    const res = await fetchImpl(url);
    return {
      attempt: { url, outcome: res.status === 200 ? "ok" : "http-error", status: res.status },
      body: res.status === 200 ? await res.json() : {},
    };
  } catch (err) {
    // A refusal and a DNS failure must read differently to the user than a 404.
    const detail = (err as { cause?: { code?: string } })?.cause?.code
      ?? (err as Error).message;
    return { attempt: { url, outcome: "unreachable", detail: String(detail) }, body: {} };
  }
}

export class LocalDiscovery implements Discovery {
  constructor(
    private readonly opts: { targets?: readonly string[]; fetchImpl?: ProbeFetch } = {},
  ) {}

  async probe(): Promise<DiscoveredValues> {
    const fetchImpl = this.opts.fetchImpl ?? defaultProbeFetch;
    const targets = this.opts.targets ?? localTargets();
    const attempts: ProbeAttempt[] = [];
    const bodies: Array<{ base: string; props: unknown; models: unknown }> = [];
    for (const base of targets) {
      const props = await attempt(fetchImpl, `${base}/props`);
      const models = await attempt(fetchImpl, `${base}/v1/models`);
      attempts.push(props.attempt, models.attempt);
      bodies.push({ base, props: props.body, models: models.body });
    }
    // Task 3 classifies `bodies` into `servers`; until then a responder is recorded
    // but not offered, which is what the second test above asserts.
    return { servers: [], attempts, probeSource: "loopback" };
  }
}

