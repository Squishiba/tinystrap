#!/usr/bin/env node
// Fake host: prints opencode-style JSONL, optionally after a delay, then exits.
import { spawn } from "node:child_process";
import { writeSync, writeFileSync } from "node:fs";

if (process.argv.includes("--grandchild")) {
  // Spawn a long-lived grandchild sharing our stdout, announce its pid, then hang.
  const gc = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000);"], { stdio: "inherit" });
  // writeSync, not process.stdout.write: writes to a pipe are async, and a
  // force-kill (taskkill /F, SIGKILL) discards anything still sitting in our
  // userspace buffer. writeSync puts the bytes in the OS pipe before we hang.
  writeSync(1, JSON.stringify({ type: "grandchild", pid: gc.pid }) + "\n");
  setTimeout(() => {}, 300_000);
} else if (process.argv.includes("--syncline")) {
  // Regression fixture for the kill-vs-pipe race: one synchronous stdout
  // line, then a ready-marker so the test knows the bytes are in the OS
  // pipe, then hang until killed.
  writeSync(1, JSON.stringify({ type: "host_event", note: "syncline" }) + "\n");
  writeFileSync("host-ready", "1");
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
