import { makeEvent, type HarnessEvent } from "@tinystrap/policy";

type Raw = {
  type?: unknown;
  tool?: unknown;
  error?: unknown;
  part?: { tool?: unknown; state?: { status?: unknown; error?: unknown } };
};

export function parseOpenCodeJsonl(taskId: string, lines: string[]): HarnessEvent[] {
  const out: HarnessEvent[] = [];
  for (const line of lines) {
    // Tolerate CRLF line endings from hosts that print \r\n.
    const text = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (!text.trim()) {
      out.push(makeEvent(taskId, "host_event", { hostEventType: "blank" }));
      continue;
    }
    let raw: Raw;
    try {
      const parsed: unknown = JSON.parse(text);
      // Non-object JSON (null, numbers, strings, booleans, arrays) is not a
      // valid event: record it losslessly as unparsed rather than dereferencing
      // it below.
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        out.push(makeEvent(taskId, "host_event", { hostEventType: "unparsed" }));
        continue;
      }
      raw = parsed as Raw;
    }
    catch { out.push(makeEvent(taskId, "host_event", { hostEventType: "unparsed" })); continue; }
    // Real opencode events carry the tool name on the part (part.tool). The fake
    // host used by the runner tests still prints the OLD shape with a top-level
    // `tool`, so fall back to that when part.tool is absent.
    const tool =
      (typeof raw.part?.tool === "string" ? raw.part.tool : undefined) ??
      (typeof raw.tool === "string" ? raw.tool : undefined);
    const status = typeof raw.part?.state?.status === "string" ? raw.part.state.status : undefined;
    switch (raw.type) {
      case "tool_use": {
        switch (status) {
          case "completed":
            out.push(makeEvent(taskId, "tool_executed", { tool }));
            break;
          case "error":
            // Inferred, NOT yet observed from the real host: we assume a failed
            // tool reports state.status "error" with the message in state.error.
            out.push(makeEvent(taskId, "tool_failed", {
              tool,
              reason: typeof raw.part?.state?.error === "string" ? raw.part.state.error : "error",
            }));
            break;
          case undefined:
            // Old-shape tool_use events (top-level `tool`, no part/state) are
            // treated as executed for backward compatibility.
            out.push(makeEvent(taskId, "tool_executed", { tool }));
            break;
          default:
            // Any other status (e.g. "pending" or "running", also unobserved) is
            // kept losslessly as a host event rather than counted as executed or
            // failed.
            out.push(makeEvent(taskId, "host_event", { hostEventType: "tool_use" }));
        }
        break;
      }
      case "tool_result":
        // Legacy shape: never observed from the real opencode host (the runner
        // tests' fake host still prints it). Kept for backward compatibility.
        out.push(makeEvent(taskId, "tool_executed", { tool }));
        break;
      case "tool_error":
        // Legacy shape: never observed from the real opencode host (the runner
        // tests' fake host still prints it). Kept for backward compatibility.
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