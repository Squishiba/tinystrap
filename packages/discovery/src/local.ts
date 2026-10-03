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
