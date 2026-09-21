export type ServerKind = "llamacpp" | "ollama" | "lmstudio" | "openai-compatible";
export type DiscoveredModel = { id: string; contextLength?: number };
export type DiscoveredServer = {
  baseUrl: string;
  kind: ServerKind;
  models: DiscoveredModel[];
};
export type DiscoveredValues = {
  servers: DiscoveredServer[];
  selectedModel?: string;
  contextLength?: number;
};

export interface Discovery {
  probe(): Promise<DiscoveredValues>;
}

export class StubDiscovery implements Discovery {
  constructor(private readonly values: DiscoveredValues) {}
  async probe(): Promise<DiscoveredValues> {
    return this.values;
  }
}
