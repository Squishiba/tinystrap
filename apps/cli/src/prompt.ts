import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { ApproveIO } from "@tinystrap/core";

// The only file in the CLI allowed to touch a TTY. The readline interface is
// built inside ask() and closed again, so constructing this IO for a run that
// never asks (--yes, export_patch) leaves stdin completely untouched, and every
// test injects its own ApproveIO instead of importing this file at all.
export function consoleApproveIO(): ApproveIO {
  return {
    out: (line) => { stdout.write(`${line}\n`); },
    ask: async (question) => {
      const rl = createInterface({ input: stdin, output: stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
  };
}
