// Probes whether llama.cpp supports: start a thinking stream, abort mid-stream,
// then resume the SAME conversation with chat_template_kwargs {"enable_thinking": false}
// and get a normal (reasoning-free) continuation. Prints FEASIBLE / NOT FEASIBLE.
const base = (process.argv[2] ?? "").replace(/\/$/, "");
if (!base) { console.log("NOT FEASIBLE: usage: node scripts/feasibility-mid-stream-close.mjs <baseUrl>"); process.exit(1); }

async function streamTurn(messages, kwargs, abortAfterMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), abortAfterMs);
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "", messages, stream: true, chat_template_kwargs: kwargs }),
    signal: ac.signal,
  });
  let reasoning = 0; let content = 0;
  try {
    for await (const piece of res.body) {
      const s = new TextDecoder().decode(piece);
      reasoning += (s.match(/"reasoning_content"/g) ?? []).length;
      content += (s.match(/"content"/g) ?? []).length;
    }
  } catch { /* aborted */ }
  clearTimeout(timer);
  return { reasoning, content };
}

const messages = [{ role: "user", content: "Think carefully: what is 17*23? Show reasoning." }];
const first = await streamTurn(messages, { enable_thinking: true }, 1500);   // abort mid-thinking
const resumed = await streamTurn(
  [...messages], { enable_thinking: false }, 30000);
if (resumed.reasoning === 0 && resumed.content > 0) {
  console.log(`FEASIBLE: aborted after ${first.reasoning} reasoning deltas; ` +
    `resumed with ${resumed.reasoning} reasoning / ${resumed.content} content deltas.`);
  process.exit(0);
}
console.log(`NOT FEASIBLE: resumed stream had ${resumed.reasoning} reasoning deltas.`);
process.exit(1);
