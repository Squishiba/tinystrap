import type { HostTask } from "@tinystrap/core";

export function buildOpenCodeArgs(task: HostTask): string[] {
  return [
    "run",
    "--format", "json",
    "--pure",
    "--dir", task.workspaceDir,
    "--model", `tinystrap/${task.model}`,
    task.prompt,
  ];
}