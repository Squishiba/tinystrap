export type ServerKind = "llamacpp" | "ollama" | "lmstudio" | "openai-compatible";
export type DiscoveredModel = { id: string; contextLength?: number };
export type DiscoveredServer = {
  baseUrl: string;
  kind: ServerKind;
  models: DiscoveredModel[];
};
export type ProbeAttempt = {
  url: string;
  outcome: "ok" | "http-error" | "unreachable";
  status?: number;
  detail?: string;   // short human phrase, never a stack trace
};
export type DiscoveredValues = {
  servers: DiscoveredServer[];
  selectedModel?: string;
  contextLength?: number;
  attempts?: ProbeAttempt[];
  probeSource?: "loopback" | "url";
};

export interface Discovery {
  probe(): Promise<DiscoveredValues>;
}

export * from "./llamacpp.js";
export * from "./local.js";

export class StubDiscovery implements Discovery {
  constructor(private readonly values: DiscoveredValues) {}
  async probe(): Promise<DiscoveredValues> {
    return this.values;
  }
}
