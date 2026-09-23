import type { HarnessEvent } from "@tinystrap/policy";

// proxyBaseUrl is the only model endpoint a host may see (spec 10.1);
// signal is how the supervisor cancels (spec 6 "a way for the caller to cancel");
// the transcript is raw host output kept beside the task for audit.

export type HostTask = {
  taskId: string;          // for events; TaskHandle.taskId
  prompt: string;          // the task instruction handed to the host
  workspaceDir: string;    // TaskHandle.workspaceDir — the host's cwd
  logsDir: string;         // TaskHandle.logsDir — transcript goes here
  model: string;           // model id the host should request, e.g. "qwen2.5-coder-7b"
  proxyBaseUrl: string;    // http://127.0.0.1:<port> — from startProxy(); never hardcoded
  timeoutMs: number;       // hard cap; on trip kill the host and report timedOut
};

export type HostRunResult = {
  exitCode: number;        // host process exit code; -1 if killed before exit
  events: HarnessEvent[];  // normalized from host output (spec 13.3)
  transcriptPath: string;  // <logsDir>/host-transcript.jsonl — raw host stdout lines
  timedOut: boolean;       // true when the timeout tripped
  cancelled: boolean;      // true when the caller's AbortSignal tripped
};

export interface HostRunner {
  run(task: HostTask, signal?: AbortSignal): Promise<HostRunResult>;
}