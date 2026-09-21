import type { StreamChunk } from "./types.js";

export const SSE_DONE = "data: [DONE]\n\n";

export function parseSseRecords(raw: string): StreamChunk[] {
  const out: StreamChunk[] = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    for (const line of block.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return out;
      if (payload === "") continue;
      out.push(JSON.parse(payload) as StreamChunk);
    }
  }
  return out;
}

export function formatSse(chunk: StreamChunk): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}
