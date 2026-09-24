import { buildDialect } from "./dialect.js";
import type { HostDialect, HostToolDisposition } from "./dialect.js";

// All facts below are from docs/superpowers/spike-findings/fixtures/opencode-tools.json
// (opencode 1.18.25, recorded). Tool NAMES already match the canonical vocabulary, so
// nameMap is empty; only argument names differ. `workdir` maps to canonical `cwd`
// (the preflight wrapper feeds it to the shell analyzer's cwd — see proxy plan Task 5).
const OPENCODE_ARG_MAPS: Record<string, Record<string, string>> = {
  edit: { filePath: "path", oldString: "oldText", newString: "newText" },
  read: { filePath: "path" },
  write: { filePath: "path" },
  bash: { workdir: "cwd" },
};

// v1 reach policy (plan Global Constraints): network and agent-spawning tools denied,
// harness-neutral todowrite allowed, bash allowed (the shell analyzer still decides).
// Data, not branches — overridable per deployment via tinystrap.toml [host.tools].
export const OPENCODE_DISPOSITIONS: Record<string, HostToolDisposition> = {
  webfetch: "deny",
  task: "deny",
  skill: "deny",
  todowrite: "allow",
};

export function createOpenCodeDialect(
  overrides: Record<string, HostToolDisposition> = {},
): HostDialect {
  return buildDialect({
    id: "opencode",
    supportsHarnessNotice: false,   // unknown-tool behavior UNVERIFIED (live-check 5 Q1)
    argMaps: OPENCODE_ARG_MAPS,
    capabilities: {
      bash: ["shell"], edit: ["fs_write"], write: ["fs_write"],
      read: ["fs_read"], glob: ["fs_read"], grep: ["fs_read"],
      todowrite: ["harness_state_write"],
      webfetch: ["network"], task: ["agent_spawn"], skill: ["agent_spawn"],
    },
    readOnly: ["read", "glob", "grep"],
    dispositions: { ...OPENCODE_DISPOSITIONS, ...overrides },
  });
}
