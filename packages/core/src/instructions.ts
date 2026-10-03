// The proxy URL a host should point at. `init` starts a proxy only long enough to
// smoke-test it and then closes it, so the instructions must name a stable URL -
// this is the port the harness documents for host runs. No command on main starts
// a proxy on this port yet; that is a known gap, reported with this plan.
export const DEFAULT_PROXY_BASE_URL = "http://127.0.0.1:8787";

// Print-only: nothing here touches the filesystem, and nothing here is imported by
// anything that writes a host config. `tinystrap init` never edits OpenCode or pi
// configuration (spec section 7 keeps host setup out of scope for the writer).
export function renderHostInstructions(opts: {
  model: string;
  proxyBaseUrl?: string;
  configPath: string;
}): string {
  const base = (opts.proxyBaseUrl ?? DEFAULT_PROXY_BASE_URL).replace(/\/+$/, "");
  // Same shape buildOpenCodeConfig produces (adapters/opencode/src/config.ts:53), so
  // what the operator pastes in is exactly what the adapter would have written.
  // Inlined as data rather than imported: `core` must not depend on an adapter.
  const openCode = JSON.stringify({
    provider: {
      tinystrap: {
        npm: "@ai-sdk/openai-compatible",
        name: "tinystrap proxy",
        options: { baseURL: `${base}/v1`, apiKey: "tinystrap" },
        models: { [opts.model]: {} },
      },
    },
  }, null, 2);
  return [
    "",
    "Next: point your coding host at the tinystrap proxy.",
    "",
    `Config written: ${opts.configPath}`,
    "tinystrap init does not edit any host configuration - nothing outside your",
    "project was created or changed. Paste the snippets below yourself.",
    "",
    "OpenCode - merge this into your OpenCode provider config:",
    "",
    openCode,
    "",
    "pi - pi is started with its endpoint in the environment (see",
    "adapters/pi/src/runner.ts); whether pi reads this variable, a config file,",
    "or a flag is unverified, so check your pi version:",
    "",
    `  OPENAI_BASE_URL=${base}/v1`,
    "",
    `Then start the proxy on ${base} and use the model id "${opts.model}".`,
    "",
  ].join("\n");
}
