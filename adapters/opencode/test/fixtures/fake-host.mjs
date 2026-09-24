#!/usr/bin/env node
// Fake host: prints opencode-style JSONL, optionally after a delay, then exits.
import { spawn } from "node:child_process";

if (process.argv.includes("--grandchild")) {
  // Spawn a long-lived grandchild sharing our stdout, announce its pid, then hang.
  const gc = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000);"], { stdio: "inherit" });
  process.stdout.write(JSON.stringify({ type: "grandchild", pid: gc.pid }) + "\n");
  setTimeout(() => {}, 300_000);
} else {
await main();
}

async function main() {
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
}
