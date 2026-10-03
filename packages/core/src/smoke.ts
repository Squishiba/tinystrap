// The init-time smoke test: one request, one tool, through the real proxy.
//
// `core` does not import @tinystrap/proxy at runtime, so this module speaks the
// wire protocol directly rather than reusing the proxy's parseSseRecords. The
// reader below is deliberately tiny; the proxy's own SSE format (sse.ts:19) is
// `data: <json>\n\n` per record.
export const SMOKE_TOOL_NAME = "tinystrap_probe";

const SMOKE_TOOL = {
  type: "function",
  function: {
    name: SMOKE_TOOL_NAME,
    description: "Report that the coding harness is wired up. Always call this.",
    parameters: {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
    },
  },
};

export type SmokeResult = { ok: boolean; toolCalls: number; detail: string };

function toolCallCount(sse: string): number {
  let count = 0;
  for (const block of sse.split(/\r?\n\r?\n/)) {
    for (const line of block.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "" || payload === "[DONE]") continue;
      try {
        const chunk = JSON.parse(payload) as {
          choices?: Array<{ delta?: { tool_calls?: unknown[] } }>;
        };
        if ((chunk.choices?.[0]?.delta?.tool_calls?.length ?? 0) > 0) count += 1;
      } catch {
        // A record we cannot parse is not a tool call; the count stays honest.
      }
    }
  }
  return count;
}

export async function runSmokeTest(opts: {
  proxyBaseUrl: string;
  model: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<SmokeResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.proxyBaseUrl.replace(/\/+$/, "");
  let sse: string;
  try {
    const res = await doFetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: opts.model,
        stream: true,
        messages: [{
          role: "user",
          content: `Call the ${SMOKE_TOOL_NAME} tool with ok: true. `
            + "Do not answer in text.",
        }],
        tools: [SMOKE_TOOL],
        tool_choice: "auto",
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
    if (!res.ok) {
      return { ok: false, toolCalls: 0, detail: `the proxy answered ${res.status}` };
    }
    sse = await res.text();
  } catch (err) {
    return { ok: false, toolCalls: 0,
      detail: `could not reach the proxy at ${base}: ${(err as Error).message}` };
  }
  const toolCalls = toolCallCount(sse);
  if (toolCalls === 0) {
    return { ok: false, toolCalls, detail:
      "the model answered without calling the " + SMOKE_TOOL_NAME
      + " tool. The proxy is up, but this model may not support tool calls. "
      + "Try a chat/instruct model that does, then re-run tinystrap doctor." };
  }
  return { ok: true, toolCalls, detail: `the model called ${SMOKE_TOOL_NAME}` };
}
