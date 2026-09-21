import { parseSseRecords } from "./sse.js";
import type { ChatRequest, Provider, StreamChunk } from "./types.js";

export class HttpProvider implements Provider {
  constructor(private readonly opts: { baseUrl: string }) {}

  async *stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamChunk> {
    const res = await fetch(`${this.opts.baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`upstream ${res.status}`);
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const piece of res.body as AsyncIterable<Uint8Array>) {
        if (signal?.aborted) return;
        buffer += decoder.decode(piece, { stream: true });
        // Consume only complete records; keep the partial tail for the next piece.
        let sep: number;
        while ((sep = findRecordEnd(buffer)) >= 0) {
          const record = buffer.slice(0, sep);
          buffer = buffer.slice(sep);
          const chunks = parseSseRecords(record);
          for (const c of chunks) yield c;
          if (record.includes("[DONE]")) return;
        }
      }
    } catch (err) {
      if (signal?.aborted) return;
      throw err;
    }
  }
}

function findRecordEnd(buf: string): number {
  const a = buf.indexOf("\n\n");
  const b = buf.indexOf("\r\n\r\n");
  if (a < 0) return b < 0 ? -1 : b + 4;
  if (b < 0) return a + 2;
  return Math.min(a + 2, b + 4);
}
