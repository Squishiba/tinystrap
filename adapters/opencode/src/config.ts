export type OpenCodeProviderConfig = {
  provider: Record<string, {
    npm: string;
    name: string;
    options: { baseURL: string; apiKey: string };
    models: Record<string, Record<string, never>>;
  }>;
};

export function buildOpenCodeConfig(proxyBaseUrl: string, modelId: string): OpenCodeProviderConfig {
  const u = new URL(proxyBaseUrl);
  const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
  if (!loopback) throw new Error(`proxy URL must be loopback, got ${proxyBaseUrl}`);
  const base = proxyBaseUrl.replace(/\/+$/, "");
  return {
    provider: {
      tinystrap: {
        npm: "@ai-sdk/openai-compatible",
        name: "tinystrap proxy",
        options: { baseURL: `${base}/v1`, apiKey: "tinystrap" },
        models: { [modelId]: {} },
      },
    },
  };
}