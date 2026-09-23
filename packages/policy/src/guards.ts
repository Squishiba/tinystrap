import type { PolicyDecision } from "./types.js";

export function checkExistingFileWrite(targetExists: boolean): PolicyDecision {
  if (!targetExists) return { effect: "allow" };
  return {
    effect: "deny",
    reason: "`write` is not allowed for an existing file.",
    correction: "No file contents were written. Use `edit` or `apply_patch`.",
    retryable: true,
  };
}

export function checkReadBeforeEdit(
  path: string,
  readSet: ReadonlySet<string>,
  slice?: { startLine: number; text: string },
): PolicyDecision {
  if (readSet.has(path)) return { effect: "allow" };
  const base = `Read \`${path}\` first, then retry the edit.`;
  const correction = slice
    ? `${base}\nCurrent content (from line ${slice.startLine + 1}):\n${slice.text}`
    : base;
  return {
    effect: "deny",
    reason: `\`${path}\` has not been read this task.`,
    correction,
    retryable: true,
  };
}
