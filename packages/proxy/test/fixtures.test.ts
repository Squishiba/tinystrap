import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeProvider, loadRecordedStreams } from "@tinystrap/proxy";

const FIXTURE = join(
  process.cwd(), "docs", "superpowers", "spike-findings", "fixtures", "streams.jsonl");

async function collect(it: AsyncIterable<{
  choices: { delta: { tool_calls?: { function?: { arguments?: string } }[] } }[] }>) {
  const out: string[] = [];
  for await (const c of it) out.push(JSON.stringify(c));
  return out;
}

describe("fixtures + FakeProvider", () => {
  it("loads both recorded streams", () => {
    const streams = loadRecordedStreams(FIXTURE);
    expect(streams.map((s) => s.attempt)).toEqual(["plain", "required"]);
    expect(streams[0].server).toBe("llamacpp");
    expect(streams[0].summary.has_tool_calls).toBe(true);
  });
  it("replays the stream with the spike's fragment shape: 6 argument fragments", async () => {
    const streams = loadRecordedStreams(FIXTURE);
    const provider = new FakeProvider(streams);
    let argFrags = 0; let nameSeenAt = -1; let chunkIndex = 0;
    for await (const c of provider.stream({ model: "m", messages: [], stream: true })) {
      for (const d of c.choices[0]?.delta.tool_calls ?? []) {
        if (d.function?.name && nameSeenAt < 0) nameSeenAt = chunkIndex;
        if (d.function?.arguments !== undefined) argFrags++;
      }
      chunkIndex++;
    }
    expect(argFrags).toBe(6);
    expect(nameSeenAt).toBeGreaterThanOrEqual(0);
  });
  it("stops yielding when aborted", async () => {
    const provider = new FakeProvider(loadRecordedStreams(FIXTURE));
    const ac = new AbortController();
    ac.abort();
    const seen = await collect(provider.stream(
      { model: "m", messages: [], stream: true }, ac.signal));
    expect(seen.length).toBe(0);
  });
});
