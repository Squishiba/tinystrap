import { makeEvent, type HarnessEvent } from "@tinystrap/policy";

type Raw = { type?: unknown; tool?: unknown; error?: unknown };

export function parseOpenCodeJsonl(taskId: string, lines: string[]): HarnessEvent[] {
  const out: HarnessEvent[] = [];
  for (const line of lines) {
    if (!line.trim()) {
      out.push(makeEvent(taskId, "host_event", { hostEventType: "blank" }));
      continue;
    }
    let raw: Raw;
    try { raw = JSON.parse(line) as Raw; }
    catch { out.push(makeEvent(taskId, "host_event", { hostEventType: "unparsed" })); continue; }
    const tool = typeof raw.tool === "string" ? raw.tool : undefined;
    switch (raw.type) {
      case "tool_use":
      case "tool_result":
        out.push(makeEvent(taskId, "tool_executed", { tool }));
        break;
      case "tool_error":
        out.push(makeEvent(taskId, "tool_failed", {
          tool, reason: typeof raw.error === "string" ? raw.error : undefined,
        }));
        break;
      default:
        out.push(makeEvent(taskId, "host_event", {
          hostEventType: typeof raw.type === "string" ? raw.type : "unknown",
        }));
    }
  }
  return out;
}