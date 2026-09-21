import type { Discovery, DiscoveredValues } from "./index.js";

export type LlamaCppFacts = {
  modelAlias: string;
  nCtx: number;
  buildInfo: string;
  totalSlots: number;
  chatTemplateCaps: Record<string, boolean>;
};

type FetchLike = (url: string) => Promise<{ status: number; json(): Promise<unknown> }>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function identifyLlamaCpp(propsBody: unknown, modelsBody: unknown): boolean {
  if (isRecord(propsBody) && typeof propsBody.build_info === "string" &&
      typeof propsBody.model_alias === "string") {
    return true;
  }
  if (isRecord(modelsBody) && Array.isArray(modelsBody.data)) {
    return modelsBody.data.some((e) =>
      isRecord(e) && e.owned_by === "llamacpp" && isRecord(e.meta));
  }
  return false;
}

export function extractLlamaCppFacts(propsBody: unknown): LlamaCppFacts | null {
  if (!isRecord(propsBody)) return null;
  const dgs = propsBody.default_generation_settings;
  if (typeof propsBody.model_alias !== "string" ||
      typeof propsBody.build_info !== "string" ||
      typeof propsBody.total_slots !== "number" ||
      !isRecord(dgs) || typeof dgs.n_ctx !== "number") {
    return null;
  }
  const caps = isRecord(propsBody.chat_template_caps)
    ? propsBody.chat_template_caps as Record<string, boolean> : {};
  return {
    modelAlias: propsBody.model_alias,
    nCtx: dgs.n_ctx,
    buildInfo: propsBody.build_info,
    totalSlots: propsBody.total_slots,
    chatTemplateCaps: caps,
  };
}

export class LlamaCppDiscovery implements Discovery {
  private facts: LlamaCppFacts | null = null;

  constructor(private readonly opts: { baseUrl: string; fetchImpl?: FetchLike }) {}

  lastFacts(): LlamaCppFacts | null { return this.facts; }

  async probe(): Promise<DiscoveredValues> {
    const fetchImpl = this.opts.fetchImpl ?? defaultFetch;
    const base = this.opts.baseUrl.replace(/\/$/, "");
    const props = await fetchImpl(`${base}/props`);
    const models = await fetchImpl(`${base}/v1/models`);
    const propsBody = props.status === 200 ? await props.json() : {};
    const modelsBody = models.status === 200 ? await models.json() : {};
    if (!identifyLlamaCpp(propsBody, modelsBody)) return { servers: [] };
    this.facts = extractLlamaCppFacts(propsBody);
    if (!this.facts) return { servers: [] };
    const data = isRecord(modelsBody) && Array.isArray(modelsBody.data) ? modelsBody.data : [];
    const ids = data.filter((e) => isRecord(e) && typeof e.id === "string")
      .map((e) => ({ id: (e as { id: string }).id, contextLength: this.facts!.nCtx }));
    return {
      servers: [{ baseUrl: base, kind: "llamacpp",
        models: ids.length > 0 ? ids : [{ id: this.facts.modelAlias, contextLength: this.facts.nCtx }] }],
      selectedModel: this.facts.modelAlias,
      contextLength: this.facts.nCtx,
    };
  }
}

const defaultFetch: FetchLike = async (url) => {
  const res = await fetch(url);
  return { status: res.status, json: () => res.json() as Promise<unknown> };
};
