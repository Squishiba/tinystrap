import { readFileSync } from "node:fs";
import { parseSseRecords } from "./sse.js";
import type { StreamChunk } from "./types.js";

export type RecordedStream = {
  server: string; attempt: string; status: number;
  chunks: StreamChunk[]; summary: Record<string, unknown>;
};

type RawLine = {
  server: string; model: string; attempt: string;
  status?: number; raw_sse?: string; summary?: Record<string, unknown>;
};

export function loadRecordedStreams(jsonlPath: string): RecordedStream[] {
  const lines = readFileSync(jsonlPath, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as RawLine);
  const out: RecordedStream[] = [];
  for (let i = 0; i < lines.length; i++) {
    const rec = lines[i];
    if (rec.raw_sse === undefined) continue;
    const next = lines[i + 1];
    out.push({
      server: rec.server,
      attempt: rec.attempt,
      status: rec.status ?? 0,
      chunks: parseSseRecords(rec.raw_sse),
      summary: next && next.attempt === rec.attempt && next.summary ? next.summary : {},
    });
  }
  return out;
}
