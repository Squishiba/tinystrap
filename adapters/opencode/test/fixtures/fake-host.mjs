#!/usr/bin/env node
// Fake host: prints opencode-style JSONL, optionally after a delay, then exits.
const sleep = process.argv.includes("--sleep")
  ? Number(process.argv[process.argv.indexOf("--sleep") + 1]) : 0;
const lines = [
  JSON.stringify({ type: "tool_use", tool: "write", callID: "c1" }),
  JSON.stringify({ type: "tool_result", tool: "write", callID: "c1", output: "ok" }),
  JSON.stringify({ type: "session.idle" }),
];
setTimeout(() => {
  for (const l of lines) process.stdout.write(l + "\n");
  process.exit(process.argv.includes("--fail") ? 3 : 0);
}, sleep);
