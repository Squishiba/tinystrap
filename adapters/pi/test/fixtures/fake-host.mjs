#!/usr/bin/env node
// Fake host: prints pi-style JSONL, optionally after a delay, then exits.
// Also echoes back OPENAI_BASE_URL so tests can assert the runner's env wiring.
const sleep = process.argv.includes("--sleep")
  ? Number(process.argv[process.argv.indexOf("--sleep") + 1]) : 0;
const lines = [
  JSON.stringify({ type: "tool_use", tool: "write", callID: "c1" }),
  JSON.stringify({ type: "tool_result", tool: "write", callID: "c1", output: "ok" }),
  JSON.stringify({ type: "session.idle" }),
  JSON.stringify({ type: "host_event", note: "env", OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? null }),
];
setTimeout(() => {
  for (const l of lines) process.stdout.write(l + "\n");
  process.exit(process.argv.includes("--fail") ? 3 : 0);
}, sleep);
