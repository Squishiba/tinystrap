import type { ChatRequest, Provider, StreamChunk } from "./types.js";
import type { RecordedStream } from "./fixtures.js";

export class FakeProvider implements Provider {
  private cursor = 0;

  constructor(private readonly streams: RecordedStream[]) {
    if (streams.length === 0) throw new Error("FakeProvider needs at least one stream");
  }

  reset(): void { this.cursor = 0; }

  async *stream(_req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamChunk> {
    const recorded = this.streams[this.cursor % this.streams.length];
    this.cursor++;
    for (const chunk of recorded.chunks) {
      if (signal?.aborted) return;
      yield chunk;
    }
  }
}
