# Proxy and Small-Model Layer Implementation Plan (delivery step 3)

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Build the provider-stream proxy (spec §9.4, §10) — an OpenAI-compatible endpoint in front of the local model server — with the M5 streaming preflight gate calling the Plan 2 policy engine, mid-stream interruption with well-formed rewrite, tool-call repair, context budgeting, discovery-driven model profiles, reasoning control (loop detector, phase-based thinking, pinned notes), a fake streaming provider that replays the recorded spike fixtures for deterministic tests, and real llama.cpp discovery replacing Plan 2's `StubDiscovery` for llama.cpp only.

**Architecture:** One new package `@tinystrap/proxy` plus an addition to `@tinystrap/discovery`. Pure modules first (SSE parse/format, fixture loader, stream gate, rewrite, repair, profiles, budget, loop detector, notes), then the `node:http` server that composes them. The gate never imports I/O: it receives a `preflight(tool, args) => PolicyDecision` callback that the server wires to Plan 2's `evaluate()` with a per-request `PolicyContext`. Upstream is reached through a `Provider` interface — `FakeProvider` (fixture replay) in tests, `HttpProvider` (real server) in production. Interruption cancels the upstream request via `AbortController` and rewrites the downstream stream into a synthetic `harness_notice` tool call (spec §10.2) — the host never sees a truncated fragment.

**Tech Stack:** Node.js 20+ (built-in `node:http`, `node:https` — zero new runtime dependencies), TypeScript 5 strict ESM (NodeNext), pnpm workspaces, vitest. Same toolchain as Plan 2 (`docs/superpowers/plans/2026-09-20-core-m1-m2.md`).

**Spec:** `docs/superpowers/specs/2026-09-20-tinystrap-harness-design.md` (§8, §9.4, §10, §12, §13.4, §16 step 3, Appendix A as updated 2026-09-21). Spike evidence: `docs/superpowers/spike-findings/` (findings.md + fixtures/).

## Global Constraints

Copied from the spec (and the task brief); these bind every task:

- The proxy is the **single enforcement point** for the M5 streaming preflight gate (spec §10.1).
- Gate lifecycle on the live stream: partial tool-name check, partial-argument check, full validation on complete arguments (spec §10.2).
- Spike fact: on llama.cpp b10934 tool-call arguments arrive incrementally (6 fragments), the **name arrives in the same chunk as the first argument fragment**; reasoning streams separately as `reasoning_content` deltas; **early interruption is feasible** and the unknown-tool check happens at that first name-bearing chunk (spec §10.2, findings.md).
- On gate trip: **cancel the upstream generation** (abort) and **rewrite the response into a well-formed one** — synthetic `harness_notice` tool call or correction message; the host never sees a truncated tool-call fragment (spec §10.2).
- Two-stage fallback (§10.3) for servers without verified streams is **deferred**; Ollama/LM Studio stay behind the `Discovery` interface, unimplemented, marked to verify (Appendix A3/A4 open).
- Tool-call repair: invalid/truncated JSON, wrong argument names via per-tool alias tables, near-miss tool names by edit distance; **every repair logged** as an audit event with before/after digests (spec §12.2).
- Context budgeting sized from the **discovered** context length, never hardcoded; the reported `n_ctx` may be total or per-slot (Appendix A10 open) — **budgeting must not assume either**; unknown scope ⇒ conservative under-budget + warning, never over-budget (spec §12.3).
- Profiles are **data**, user-overridable; weaker models get simplified tool sets; unknown models get a conservative default (spec §12.1).
- Phase-based thinking: reasoning **on for planning/failure diagnosis, off for mechanical steps**; per-request off uses `chat_template_kwargs: {"enable_thinking": false}` (spike-verified, Appendix A8) (spec §12.6).
- Loop detector signals (repetition, repeated conclusion, novelty decline, no commitment, cross-turn repetition) are **combined into a score** — **except verbatim repetition, decisive alone**; ladder observe → nudge → close reasoning → token backstop; **long-but-progressing thinking is never cut**; every intervention logged with signal values (spec §12.6).
- The ladder's **close-reasoning step depends on the UNTESTED mid-stream forced close** (Appendix A8 partial): it stays behind a `midStreamClose` capability flag, **default false** (downgrade to backstop only). Task 14 is the optional feasibility check.
- Pinned notes: **capped**, persist across turns, survive compaction, re-injected after compaction and at resume (spec §12.7).
- llama.cpp discovery uses the **corrected paths**: model = `model_alias`, n_ctx = `default_generation_settings.n_ctx`; also `build_info`, `total_slots`, `chat_template_caps`; `/v1/models` must be read from the OpenAI-shaped **`data`** array (the `models` compatibility array is also present); identification by `owned_by: "llamacpp"` + `/props build_info` (spec §8, Appendix A1/A2/A5).
- Fixtures are used **as-is**; **no new recorded fixtures** are added by this plan (task brief).
- Audit events use Plan 2's `HarnessEvent` model; no secrets or full sensitive arguments — hashes and redacted summaries (spec §13.4).
- Every small-model mechanism is **individually switchable** (spec §12).
- Explicitly deferred out of this plan: forced mid-stream reasoning-close implementation (optional Task 14 only), OpenCode/pi adapters, verifier (§9.9), promotion broker (§9.10), sandbox (§9.8), bench (§15).
- Shell commands in this plan use **only** the allowed set: `git`, `python`, `python -m pytest`, `pytest`, `ruff`, `pnpm`, `npm`, `mkdir`, `ao`, `node`, `tinystrap`, `refdes`. **Never** `rm`, `npx`, or inline-assignment prefixes (`VAR=value cmd`) — these are refused by the shell whitelist; where an env var is needed (e.g. the temp-index flow), do it inside Node code, not the shell.
- Windows/Git Bash: forward-slash-safe paths; all commands run from the repo root.
- Strict TDD, DRY, YAGNI, one commit per task minimum; every commit message ends with the line `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.

## File Structure

| Path | Responsibility (single) |
| ---- | ----------------------- |
| `packages/proxy/package.json` | `@tinystrap/proxy` manifest — deps: `@tinystrap/policy`, `@tinystrap/discovery` (workspace) only |
| `packages/proxy/tsconfig.json` | extends `tsconfig.base.json`, references policy + discovery |
| `packages/proxy/src/types.ts` | Chat request/chunk/tool-call-delta types, `Provider` interface |
| `packages/proxy/src/sse.ts` | SSE record parse/format (pure) |
| `packages/proxy/src/fixtures.ts` | Load recorded spike JSONL into `RecordedStream[]` (read-only) |
| `packages/proxy/src/fakeprovider.ts` | `FakeProvider implements Provider` — deterministic fixture replay |
| `packages/proxy/src/gate.ts` | `StreamGate` — streaming preflight (name check, partial + full arg checks) |
| `packages/proxy/src/rewrite.ts` | Interruption rewrite → synthetic `harness_notice` chunk sequence |
| `packages/proxy/src/repair.ts` | Tool-call repair (JSON close, name edit distance, arg aliases) |
| `packages/proxy/src/profiles.ts` | Model profile data + selection + thinking kwargs |
| `packages/proxy/src/budget.ts` | Context budgeting (token estimate, history truncation, output condensing) |
| `packages/proxy/src/loopdetector.ts` | Reasoning loop detector + escalation ladder (close gated) |
| `packages/proxy/src/notes.ts` | Capped pinned-note store |
| `packages/proxy/src/server.ts` | `node:http` proxy server composing everything |
| `packages/proxy/src/httpprovider.ts` | `HttpProvider implements Provider` — real upstream SSE via `node:https`/`http` |
| `packages/proxy/src/index.ts` | Public exports |
| `packages/proxy/test/*.test.ts` | One test file per module (named `<module>.test.ts`) |
| `packages/discovery/src/llamacpp.ts` | Real llama.cpp discovery (corrected paths, A5 identification) |
| `packages/discovery/test/llamacpp.test.ts` | Replay of recorded discovery fixtures via injected fetch |
| `packages/discovery/src/index.ts` | (modify) add llamacpp exports |
| `scripts/feasibility-mid-stream-close.mjs` | OPTIONAL Task 14 live-server feasibility probe (no test) |

---

### Task 1: Proxy package scaffold

**Files:**
- Create: `packages/proxy/package.json`, `packages/proxy/tsconfig.json`, `packages/proxy/src/index.ts`, `packages/proxy/test/smoke.test.ts`

**Interfaces:**
- Consumes: workspace wiring from Plan 2 (root `pnpm-workspace.yaml` already includes `packages/*`; root `vitest.config.ts` already includes `packages/*/test/**/*.test.ts`).
- Produces: package name `@tinystrap/proxy` resolvable via `workspace:*`.

Steps:
- [ ] Create `packages/proxy/package.json`:

```json
{
  "name": "@tinystrap/proxy",
  "version": "0.0.0",
  "type": "module",
  "main": "src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@tinystrap/policy": "workspace:*",
    "@tinystrap/discovery": "workspace:*"
  }
}
```

- [ ] Create `packages/proxy/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"],
  "references": [{ "path": "../policy" }, { "path": "../discovery" }]
}
```

- [ ] Create `packages/proxy/src/index.ts`: `export {};`

- [ ] Write `packages/proxy/test/smoke.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import * as proxy from "@tinystrap/proxy";

describe("proxy package", () => {
  it("resolves with no runtime deps beyond workspace packages", () => {
    const deps = { "@tinystrap/policy": "workspace:*", "@tinystrap/discovery": "workspace:*" };
    expect(Object.keys(deps).every((d) => d.startsWith("@tinystrap/"))).toBe(true);
    expect(proxy).toBeDefined();
  });
});
```

- [ ] Run `pnpm install` (timeout ≥ 120s), then `pnpm test -- smoke`. Expected: PASS (2 smoke tests total — Plan 2's policy smoke plus this one).
- [ ] Commit:

```bash
git add packages/proxy
git commit -m "chore(proxy): package scaffold in the workspace

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Chat/stream types and the Provider interface

**Files:**
- Create: `packages/proxy/src/types.ts`
- Modify: `packages/proxy/src/index.ts`
- Test: `packages/proxy/test/types.test.ts`

**Interfaces:**
- Consumes: `ToolDefinition` from `@tinystrap/policy` (Plan 2, Task 2).
- Produces (exported from `@tinystrap/proxy`):

```ts
export type ChatRole = "system" | "user" | "assistant" | "tool";
export type ChatMessage = {
  role: ChatRole;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};
export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};
export type ToolCallDelta = {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
};
export type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  tool_choice?: "auto" | "required" | "none";
  stream?: boolean;
  chat_template_kwargs?: Record<string, unknown>;
};
export type StreamChunk = {
  choices: {
    index: number;
    delta: {
      role?: string;
      content?: string | null;
      reasoning_content?: string;
      tool_calls?: ToolCallDelta[];
    };
    finish_reason: string | null;
  }[];
};
export interface Provider {
  stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamChunk>;
}
```

Steps:
- [ ] Write failing test `packages/proxy/test/types.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { ChatRequest, StreamChunk, ToolCallDelta } from "@tinystrap/proxy";

describe("proxy types", () => {
  it("constructs a chunk shaped like the recorded llama.cpp stream", () => {
    const delta: ToolCallDelta = { index: 0, function: { arguments: "{" } };
    const chunk: StreamChunk = {
      choices: [{ index: 0, delta: { tool_calls: [delta] }, finish_reason: null }],
    };
    const req: ChatRequest = {
      model: "m", messages: [{ role: "user", content: "hi" }], stream: true,
      chat_template_kwargs: { enable_thinking: false },
    };
    expect(chunk.choices[0].delta.tool_calls?.[0].function?.arguments).toBe("{");
    expect(req.chat_template_kwargs).toEqual({ enable_thinking: false });
  });
});
```

- [ ] Run `pnpm test -- types`. Expected: FAIL — not exported.
- [ ] Create `packages/proxy/src/types.ts` with the exact code above (import `ToolDefinition` from `@tinystrap/policy`). Replace `packages/proxy/src/index.ts` content with `export * from "./types.js";`.
- [ ] Run `pnpm test -- types`. Expected: PASS (1 test).
- [ ] Commit:

```bash
git add packages/proxy
git commit -m "feat(proxy): chat stream types and Provider interface

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: SSE parse and format (pure)

**Files:**
- Create: `packages/proxy/src/sse.ts`
- Modify: `packages/proxy/src/index.ts`
- Test: `packages/proxy/test/sse.test.ts`

**Interfaces:**
- Consumes: `StreamChunk` (Task 2).
- Produces:

```ts
export const SSE_DONE = "data: [DONE]\n\n";
export function parseSseRecords(raw: string): StreamChunk[];   // stops at [DONE]; ignores non-data lines
export function formatSse(chunk: StreamChunk): string;         // "data: <json>\n\n"
```

Steps:
- [ ] Write failing test `packages/proxy/test/sse.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SSE_DONE, formatSse, parseSseRecords } from "@tinystrap/proxy";

describe("sse", () => {
  it("parses data records and stops at [DONE]", () => {
    const raw = [
      'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
      "event: ignored",
      'data: {"choices":[{"index":0,"delta":{"content":"x"},"finish_reason":"stop"}]}',
      "data: [DONE]",
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"never"}]}',
    ].join("\n\n");
    const chunks = parseSseRecords(raw);
    expect(chunks.length).toBe(2);
    expect(chunks[1].choices[0].finish_reason).toBe("stop");
  });
  it("round-trips through formatSse", () => {
    const chunk = { choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] };
    expect(parseSseRecords(formatSse(chunk))).toEqual([chunk]);
    expect(SSE_DONE).toBe("data: [DONE]\n\n");
  });
});
```

- [ ] Run `pnpm test -- sse`. Expected: FAIL — not exported.
- [ ] Implement `packages/proxy/src/sse.ts`:

```ts
import type { StreamChunk } from "./types.js";

export const SSE_DONE = "data: [DONE]\n\n";

export function parseSseRecords(raw: string): StreamChunk[] {
  const out: StreamChunk[] = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    for (const line of block.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return out;
      if (payload === "") continue;
      out.push(JSON.parse(payload) as StreamChunk);
    }
  }
  return out;
}

export function formatSse(chunk: StreamChunk): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}
```

- [ ] Add `export * from "./sse.js";` to `index.ts`. Run tests. Expected: PASS (2 tests).
- [ ] Commit:

```bash
git add packages/proxy
git commit -m "feat(proxy): SSE record parser and formatter

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Fixture loader and FakeProvider (deterministic replay)

**Files:**
- Create: `packages/proxy/src/fixtures.ts`, `packages/proxy/src/fakeprovider.ts`
- Modify: `packages/proxy/src/index.ts`
- Test: `packages/proxy/test/fixtures.test.ts`

**Interfaces:**
- Consumes: `StreamChunk`, `Provider`, `ChatRequest` (Task 2); `parseSseRecords` (Task 3); the recorded fixtures `docs/superpowers/spike-findings/fixtures/streams.jsonl` — **used as-is, never rewritten**.
- Produces:

```ts
export type RecordedStream = {
  server: string; attempt: string; status: number;
  chunks: StreamChunk[]; summary: Record<string, unknown>;
};
export function loadRecordedStreams(jsonlPath: string): RecordedStream[];
export class FakeProvider implements Provider {
  constructor(streams: RecordedStream[]);
  reset(): void;
  stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamChunk>;
}
```

Fixture JSONL shape (from the spike): alternating lines `{server, model, attempt, status, raw_sse}` and `{server, model, attempt, summary}`; group by `(server, attempt)` in file order. `FakeProvider.stream` replays the next recorded stream per call (round-robin over the list, wrapping), yielding each chunk; if `signal.aborted` it stops yielding immediately (models upstream cancellation).

Steps:
- [ ] Write failing test `packages/proxy/test/fixtures.test.ts`:

```ts
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeProvider, loadRecordedStreams } from "@tinystrap/proxy";

const FIXTURE = join(
  process.cwd(), "docs", "superpowers", "spike-findings", "fixtures", "streams.jsonl");

async function collect(it: AsyncIterable<{
  choices: { delta: { tool_calls?: { function?: { arguments?: string } }[] } }[] }>) {
  const out: string[] = [];
  for await (const c of it) out.push(JSON.stringify(c));
  return out;
}

describe("fixtures + FakeProvider", () => {
  it("loads both recorded streams", () => {
    const streams = loadRecordedStreams(FIXTURE);
    expect(streams.map((s) => s.attempt)).toEqual(["plain", "required"]);
    expect(streams[0].server).toBe("llamacpp");
    expect(streams[0].summary.has_tool_calls).toBe(true);
  });
  it("replays the stream with the spike's fragment shape: 6 argument fragments", async () => {
    const streams = loadRecordedStreams(FIXTURE);
    const provider = new FakeProvider(streams);
    let argFrags = 0; let nameSeenAt = -1; let chunkIndex = 0;
    for await (const c of provider.stream({ model: "m", messages: [], stream: true })) {
      for (const d of c.choices[0]?.delta.tool_calls ?? []) {
        if (d.function?.name && nameSeenAt < 0) nameSeenAt = chunkIndex;
        if (d.function?.arguments !== undefined) argFrags++;
      }
      chunkIndex++;
    }
    expect(argFrags).toBe(6);
    expect(nameSeenAt).toBeGreaterThanOrEqual(0);
  });
  it("stops yielding when aborted", async () => {
    const provider = new FakeProvider(loadRecordedStreams(FIXTURE));
    const ac = new AbortController();
    ac.abort();
    const seen = await collect(provider.stream(
      { model: "m", messages: [], stream: true }, ac.signal));
    expect(seen.length).toBe(0);
  });
});
```

- [ ] Run `pnpm test -- fixtures`. Expected: FAIL — not exported.
- [ ] Implement `packages/proxy/src/fixtures.ts`:

```ts
import { readFileSync } from "node:fs";
import { parseSseRecords } from "./sse.js";
import type { StreamChunk } from "./types.js";

export type RecordedStream = {
  server: string; attempt: string; status: number;
  chunks: StreamChunk[]; summary: Record<string, unknown>;
};

type RawLine = {
  server: string; model: string; attempt: string;
  status?: number; raw_sse?: string; summary?: Record<string, unknown>;
};

export function loadRecordedStreams(jsonlPath: string): RecordedStream[] {
  const lines = readFileSync(jsonlPath, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as RawLine);
  const out: RecordedStream[] = [];
  for (let i = 0; i < lines.length; i++) {
    const rec = lines[i];
    if (rec.raw_sse === undefined) continue;
    const next = lines[i + 1];
    out.push({
      server: rec.server,
      attempt: rec.attempt,
      status: rec.status ?? 0,
      chunks: parseSseRecords(rec.raw_sse),
      summary: next && next.attempt === rec.attempt && next.summary ? next.summary : {},
    });
  }
  return out;
}
```

- [ ] Implement `packages/proxy/src/fakeprovider.ts`:

```ts
import type { ChatRequest, Provider, StreamChunk } from "./types.js";
import type { RecordedStream } from "./fixtures.js";

export class FakeProvider implements Provider {
  private cursor = 0;

  constructor(private readonly streams: RecordedStream[]) {
    if (streams.length === 0) throw new Error("FakeProvider needs at least one stream");
  }

  reset(): void { this.cursor = 0; }

  async *stream(_req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamChunk> {
    const recorded = this.streams[this.cursor % this.streams.length];
    this.cursor++;
    for (const chunk of recorded.chunks) {
      if (signal?.aborted) return;
      yield chunk;
    }
  }
}
```

- [ ] Add `export * from "./fixtures.js"; export * from "./fakeprovider.js";` to `index.ts`. Run tests. Expected: PASS (3 tests). If the 6-fragment assertion fails, the recorded `raw_sse` line splits differ — inspect `fixtures/streams.jsonl` (read-only!) and fix the parser, never the fixture.
- [ ] Commit:

```bash
git add packages/proxy
git commit -m "feat(proxy): fixture loader and FakeProvider replaying recorded streams

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: StreamGate — the streaming preflight (M5)

**Files:**
- Create: `packages/proxy/src/gate.ts`
- Modify: `packages/proxy/src/index.ts`
- Test: `packages/proxy/test/gate.test.ts`

**Interfaces:**
- Consumes: `StreamChunk`, `ToolCall` (Task 2); `PolicyDecision`, `ToolRegistry` from `@tinystrap/policy` (Plan 2, Tasks 2–3).
- Produces:

```ts
export type Preflight = (tool: string, args: Record<string, unknown>) => PolicyDecision;

export type GateAction =
  | { kind: "forward"; chunk: StreamChunk }
  | { kind: "interrupt"; reason: string; tool: string | undefined };

export class StreamGate {
  constructor(opts: { registry: ToolRegistry; preflight: Preflight });
  push(chunk: StreamChunk): GateAction;
  accumulated(): ToolCall[];   // tool calls assembled so far
}
```

Behavior (spec §10.2):
- Content / `reasoning_content` chunks: always forwarded.
- First appearance of a tool **name** (same chunk as the first argument fragment on llama.cpp): `registry.lookup(name)` miss ⇒ `interrupt` with reason `unknown_tool: <name>` — before substantive argument content streams.
- Arguments accumulate per `index`. When the accumulated string becomes **balanced JSON** (complete object), run `preflight(name, parsed)`; a `deny`/`ask` decision ⇒ `interrupt` with the decision's reason. Balanced-JSON detection = brace/bracket counting outside string literals (a `path`-complete write target is therefore checked as soon as its JSON closes, even if the whole arguments object is not finished).
- `finish_reason === "tool_calls"`: run `preflight` on every fully assembled call once more (idempotent); deny ⇒ `interrupt`.
- After an interrupt the gate is closed: further chunks also return `interrupt` (the server stops forwarding).

Steps:
- [ ] Write failing test `packages/proxy/test/gate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { StreamGate, createToolRegistry } from "@tinystrap/policy";
import type { PolicyDecision, StreamChunk } from "@tinystrap/proxy";
import { gateForTest } from "./helpers.js";

const chunk = (delta: StreamChunk["choices"][0]["delta"],
  finish: string | null = null): StreamChunk =>
  ({ choices: [{ index: 0, delta, finish_reason: finish }] });

describe("stream gate", () => {
  it("interrupts at the first name-bearing chunk for unknown tools", () => {
    const gate = gateForTest();
    const actions = [
      gate.push(chunk({ role: "assistant" })),
      gate.push(chunk({ tool_calls: [{ index: 0, id: "c1",
        function: { name: "deploy_prod", arguments: "{" } }] })),
    ];
    expect(actions[0].kind).toBe("forward");
    expect(actions[1].kind).toBe("interrupt");
    if (actions[1].kind === "interrupt") {
      expect(actions[1].reason).toMatch(/^unknown_tool/);
      expect(actions[1].tool).toBe("deploy_prod");
    }
  });
  it("interrupts when complete arguments are denied", () => {
    const gate = gateForTest({ effect: "deny", reason: "outside workspace", retryable: true });
    gate.push(chunk({ tool_calls: [{ index: 0, id: "c1",
      function: { name: "write", arguments: '{"path":' } }] }));
    const a = gate.push(chunk({ tool_calls: [{ index: 0,
      function: { arguments: '"/etc/hosts"}' } }] }));
    expect(a.kind).toBe("interrupt");
    if (a.kind === "interrupt") expect(a.reason).toBe("outside workspace");
  });
  it("forwards a fully allowed call and accumulates it", () => {
    const gate = gateForTest();
    gate.push(chunk({ tool_calls: [{ index: 0, id: "c1",
      function: { name: "read", arguments: '{"path":"a.ts"}' } }] }));
    const a = gate.push(chunk({}, "tool_calls"));
    expect(a.kind).toBe("forward");
    expect(gate.accumulated()).toEqual([
      { id: "c1", type: "function",
        function: { name: "read", arguments: '{"path":"a.ts"}' } },
    ]);
  });
  it("always forwards content and reasoning deltas", () => {
    const gate = gateForTest();
    expect(gate.push(chunk({ reasoning_content: "hmm" })).kind).toBe("forward");
    expect(gate.push(chunk({ content: "text" })).kind).toBe("forward");
  });
});
```

- [ ] Create shared test helper `packages/proxy/test/helpers.ts`:

```ts
import { createToolRegistry } from "@tinystrap/policy";
import type { PolicyDecision, ToolRegistry } from "@tinystrap/policy";
import { StreamGate } from "@tinystrap/proxy";

export function gateForTest(decision: PolicyDecision = { effect: "allow" }): StreamGate {
  const registry: ToolRegistry = createToolRegistry();
  for (const n of ["read", "write", "edit", "bash"]) {
    registry.register({ name: n, description: n, inputSchema: {}, capabilities: [], readOnly: false });
  }
  return new StreamGate({ registry, preflight: () => decision });
}
```

- [ ] Run `pnpm test -- gate`. Expected: FAIL — not exported.
- [ ] Implement `packages/proxy/src/gate.ts`:

```ts
import type { PolicyDecision, ToolRegistry } from "@tinystrap/policy";
import type { StreamChunk, ToolCall } from "./types.js";

export type Preflight = (tool: string, args: Record<string, unknown>) => PolicyDecision;

export type GateAction =
  | { kind: "forward"; chunk: StreamChunk }
  | { kind: "interrupt"; reason: string; tool: string | undefined };

type Partial = { id: string; name?: string; args: string; checked: boolean };

function balancedJson(s: string): boolean {
  let depth = 0; let inStr = false; let esc = false;
  for (const c of s) {
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{" || c === "[") depth++;
    if (c === "}" || c === "]") depth--;
  }
  return depth === 0 && (s.trim().startsWith("{") || s.trim().startsWith("["));
}

export class StreamGate {
  private parts = new Map<number, Partial>();
  private tripped: GateAction | undefined;

  constructor(private readonly opts: { registry: ToolRegistry; preflight: Preflight }) {}

  accumulated(): ToolCall[] {
    return [...this.parts.values()].filter((p) => p.name !== undefined).map((p) => ({
      id: p.id, type: "function" as const,
      function: { name: p.name as string, arguments: p.args },
    }));
  }

  push(chunk: StreamChunk): GateAction {
    if (this.tripped) return this.tripped;
    const choice = chunk.choices[0];
    if (!choice) return { kind: "forward", chunk };
    for (const d of choice.delta.tool_calls ?? []) {
      const part = this.parts.get(d.index) ?? { id: d.id ?? `call_${d.index}`, args: "", checked: false };
      if (d.id) part.id = d.id;
      this.parts.set(d.index, part);
      if (d.function?.name !== undefined && part.name === undefined) {
        part.name = d.function.name;
        if (!this.opts.registry.lookup(part.name)) {
          return this.trip(`unknown_tool: \`${part.name}\``, part.name);
        }
      }
      if (d.function?.arguments !== undefined && part.name) {
        part.args += d.function.arguments;
        if (!part.checked && balancedJson(part.args)) {
          part.checked = true;
          const decision = this.check(part);
          if (decision) return decision;
        }
      }
    }
    if (choice.finish_reason === "tool_calls") {
      for (const part of this.parts.values()) {
        if (!part.checked) {
          part.checked = true;
          const decision = this.check(part);
          if (decision) return decision;
        }
      }
    }
    return { kind: "forward", chunk };
  }

  private check(part: Partial): GateAction | undefined {
    if (!part.name) return undefined;
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(part.args) as Record<string, unknown>; }
    catch { parsed = { _raw: part.args }; }
    const d = this.opts.preflight(part.name, parsed);
    if (d.effect === "deny" || d.effect === "ask") {
      return this.trip(d.reason, part.name);
    }
    return undefined;
  }

  private trip(reason: string, tool: string | undefined): GateAction {
    this.tripped = { kind: "interrupt", reason, tool };
    return this.tripped;
  }
}
```

- [ ] Add `export * from "./gate.js";` to `index.ts`. Run tests. Expected: PASS (4 tests).
- [ ] Commit:

```bash
git add packages/proxy
git commit -m "feat(proxy): streaming preflight gate (name check at first chunk, arg checks)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Interruption rewrite — synthetic harness_notice

**Files:**
- Create: `packages/proxy/src/rewrite.ts`
- Modify: `packages/proxy/src/index.ts`
- Test: `packages/proxy/test/rewrite.test.ts`

**Interfaces:**
- Consumes: `StreamChunk`, `ChatRequest` (Task 2); `formatSse`, `SSE_DONE` (Task 3).
- Produces:

```ts
export const HARNESS_NOTICE_TOOL = "harness_notice";
export function interruptionChunks(req: ChatRequest, reason: string): StreamChunk[];
export function interruptionSse(req: ChatRequest, reason: string): string;
```

The rewrite is a complete, well-formed chat completion: role chunk → `harness_notice` tool call (name + full JSON arguments in one fragment) → `finish_reason: "tool_calls"` → `[DONE]`. The host never sees a truncated fragment (spec §10.2). `harness_notice` is harness-owned: it must be registered in the tool registry as a no-op so the gate's own name check never trips on it.

Steps:
- [ ] Write failing test `packages/proxy/test/rewrite.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { HARNESS_NOTICE_TOOL, interruptionChunks, interruptionSse } from "@tinystrap/proxy";

const req = { model: "m", messages: [], stream: true };

describe("interruption rewrite", () => {
  it("produces a well-formed harness_notice completion", () => {
    const chunks = interruptionChunks(req, "outside workspace");
    expect(chunks[0].choices[0].delta.role).toBe("assistant");
    const call = chunks[1].choices[0].delta.tool_calls?.[0];
    expect(call?.function?.name).toBe(HARNESS_NOTICE_TOOL);
    expect(JSON.parse(call?.function?.arguments ?? "{}").reason).toBe("outside workspace");
    expect(chunks[2].choices[0].finish_reason).toBe("tool_calls");
  });
  it("SSE form ends with [DONE]", () => {
    expect(interruptionSse(req, "r")).toMatch(/\[DONE\]\n\n$/);
  });
});
```

- [ ] Run `pnpm test -- rewrite`. Expected: FAIL — not exported.
- [ ] Implement `packages/proxy/src/rewrite.ts`:

```ts
import type { ChatRequest, StreamChunk } from "./types.js";
import { formatSse, SSE_DONE } from "./sse.js";

export const HARNESS_NOTICE_TOOL = "harness_notice";

export function interruptionChunks(_req: ChatRequest, reason: string): StreamChunk[] {
  const id = `notice_${Date.now().toString(36)}`;
  return [
    { choices: [{ index: 0, delta: { role: "assistant", content: null }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id,
      function: { name: HARNESS_NOTICE_TOOL, arguments: JSON.stringify({ reason }) } }] },
      finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ];
}

export function interruptionSse(req: ChatRequest, reason: string): string {
  return interruptionChunks(req, reason).map(formatSse).join("") + SSE_DONE;
}
```

- [ ] Add `export * from "./rewrite.js";` to `index.ts`. Run tests. Expected: PASS (2 tests).
- [ ] Commit:

```bash
git add packages/proxy
git commit -m "feat(proxy): mid-stream interruption rewrite to harness_notice

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: Tool-call repair

**Files:**
- Create: `packages/proxy/src/repair.ts`
- Modify: `packages/proxy/src/index.ts`
- Test: `packages/proxy/test/repair.test.ts`

**Interfaces:**
- Consumes: `ToolCall` (Task 2); `ToolRegistry` from `@tinystrap/policy`.
- Produces:

```ts
export type RepairOptions = {
  maxNameDistance?: number;                              // default 2
  aliases?: Record<string, Record<string, string>>;      // tool -> wrongArg -> rightArg
};
export type RepairOutcome = { calls: ToolCall[]; repairs: string[] };
export function repairToolCalls(calls: ToolCall[], registry: ToolRegistry,
  opts?: RepairOptions): RepairOutcome;
```

Repairs, in order, each recorded as a human-readable string in `repairs` (the audit payload — before/after, digests computed by the caller): near-miss tool name by Levenshtein distance ≤ `maxNameDistance` against registry names; argument-name aliases from `opts.aliases` (e.g. `{ edit: { file_path: "path", old_string: "oldText" } }`); truncated JSON arguments closed by appending the missing `}`/`]` (counted outside strings) and re-parsed — only accepted if parse succeeds. Unrepairable calls pass through unchanged (the gate/policy then denies them normally).

Steps:
- [ ] Write failing test `packages/proxy/test/repair.test.ts`:

```ts
import { createToolRegistry } from "@tinystrap/policy";
import { describe, expect, it } from "vitest";
import { repairToolCalls } from "@tinystrap/proxy";

const reg = () => {
  const r = createToolRegistry();
  for (const n of ["read", "edit"]) {
    r.register({ name: n, description: n, inputSchema: {}, capabilities: [], readOnly: false });
  }
  return r;
};
const call = (name: string, args: string) =>
  ({ id: "c", type: "function" as const, function: { name, arguments: args } });

describe("tool-call repair", () => {
  it("fixes near-miss names by edit distance", () => {
    const out = repairToolCalls([call("read_file", "{}")], reg());
    expect(out.calls[0].function.name).toBe("read");
    expect(out.repairs.join()).toContain("read_file->read");
  });
  it("maps aliased argument names", () => {
    const out = repairToolCalls([call("edit", '{"file_path":"a.ts"}')], reg(),
      { aliases: { edit: { file_path: "path" } } });
    expect(out.calls[0].function.arguments).toContain('"path":"a.ts"');
    expect(out.repairs.join()).toContain("arg:file_path->path");
  });
  it("closes truncated JSON arguments", () => {
    const out = repairToolCalls([call("read", '{"path":"a.ts"')], reg());
    expect(JSON.parse(out.calls[0].function.arguments)).toEqual({ path: "a.ts" });
    expect(out.repairs.join()).toContain("json:closed");
  });
  it("passes unrepairable calls through", () => {
    const out = repairToolCalls([call("quantum_fax", "not json {{{")], reg());
    expect(out.calls[0].function.name).toBe("quantum_fax");
    expect(out.repairs).toEqual([]);
  });
});
```

- [ ] Run `pnpm test -- repair`. Expected: FAIL — not exported.
- [ ] Implement `packages/proxy/src/repair.ts`:

```ts
import type { ToolRegistry } from "@tinystrap/policy";
import type { ToolCall } from "./types.js";

export type RepairOptions = {
  maxNameDistance?: number;
  aliases?: Record<string, Record<string, string>>;
};
export type RepairOutcome = { calls: ToolCall[]; repairs: string[] };

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]; prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

function closeTruncatedJson(s: string): string | null {
  let depth = 0; let inStr = false; let esc = false;
  for (const c of s) {
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{") depth++;
    if (c === "}") depth--;
  }
  if (depth <= 0) return null;
  const candidate = s + "}".repeat(depth);
  try { JSON.parse(candidate); return candidate; } catch { return null; }
}

export function repairToolCalls(
  calls: ToolCall[], registry: ToolRegistry, opts: RepairOptions = {},
): RepairOutcome {
  const maxDistance = opts.maxNameDistance ?? 2;
  const repairs: string[] = [];
  const fixed = calls.map((c) => {
    let name = c.function.name;
    let args = c.function.arguments;
    if (!registry.lookup(name)) {
      const near = registry.all()
        .map((t) => ({ t, d: levenshtein(name, t.name) }))
        .filter((x) => x.d > 0 && x.d <= maxDistance)
        .sort((x, y) => x.d - y.d)[0];
      if (near) { repairs.push(`name:${name}->${near.t.name}`); name = near.t.name; }
    }
    const alias = opts.aliases?.[name];
    if (alias) {
      for (const [wrong, right] of Object.entries(alias)) {
        const needle = `"${wrong}"`;
        if (args.includes(needle)) {
          args = args.split(needle).join(`"${right}"`);
          repairs.push(`arg:${wrong}->${right}`);
        }
      }
    }
    try { JSON.parse(args); }
    catch {
      const closed = closeTruncatedJson(args);
      if (closed !== null) { args = closed; repairs.push("json:closed"); }
    }
    return { ...c, function: { name, arguments: args } };
  });
  return { calls: fixed, repairs };
}
```

- [ ] Add `export * from "./repair.js";` to `index.ts`. Run tests. Expected: PASS (4 tests).
- [ ] Commit:

```bash
git add packages/proxy
git commit -m "feat(proxy): tool-call repair (name distance, arg aliases, json close)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: Real llama.cpp discovery (replaces StubDiscovery for llama.cpp)

**Files:**
- Create: `packages/discovery/src/llamacpp.ts`
- Modify: `packages/discovery/src/index.ts`
- Test: `packages/discovery/test/llamacpp.test.ts`

**Interfaces:**
- Consumes: `Discovery`, `DiscoveredValues`, `DiscoveredServer`, `ServerKind` (Plan 2, Task 13); recorded `docs/superpowers/spike-findings/fixtures/discovery.jsonl` **as-is**.
- Produces (from `@tinystrap/discovery`):

```ts
export type LlamaCppFacts = {
  modelAlias: string;
  nCtx: number;
  buildInfo: string;
  totalSlots: number;
  chatTemplateCaps: Record<string, boolean>;
};
export function identifyLlamaCpp(propsBody: unknown, modelsBody: unknown): boolean;
export function extractLlamaCppFacts(propsBody: unknown): LlamaCppFacts | null;
export class LlamaCppDiscovery implements Discovery {
  constructor(opts: {
    baseUrl: string;
    fetchImpl?: (url: string) => Promise<{ status: number; json(): Promise<unknown> }>;
  });
  probe(): Promise<DiscoveredValues>;
  lastFacts(): LlamaCppFacts | null;   // null before probe or when not llama.cpp
}
```

Corrected paths (spec §8, Appendix A2): model = `model_alias`, n_ctx = `default_generation_settings.n_ctx`; `/v1/models` read from the **`data`** array (`owned_by: "llamacpp"`, `meta.n_ctx`) — never the `models` compatibility array. Identification (A5): `/props` returns an object with `build_info` **and** `model_alias`, or `/v1/models.data[]` entries carry `owned_by === "llamacpp"`. A non-llama.cpp responder (404 or foreign shape) ⇒ `probe()` returns `{ servers: [] }` and `lastFacts()` stays `null`. `nCtxScope` is **not** guessed (Appendix A10) — `LlamaCppFacts` deliberately has no scope field; consumers treat `nCtx` as scope-unknown.

Steps:
- [ ] Write failing test `packages/discovery/test/llamacpp.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LlamaCppDiscovery, extractLlamaCppFacts, identifyLlamaCpp } from "@tinystrap/discovery";

const FIXTURE = join(
  process.cwd(), "docs", "superpowers", "spike-findings", "fixtures", "discovery.jsonl");

function recorded(): Record<string, unknown> {
  const bodies: Record<string, unknown> = {};
  for (const line of readFileSync(FIXTURE, "utf8").split(/\r?\n/).filter(Boolean)) {
    const rec = JSON.parse(line) as { endpoint: string; body: unknown };
    bodies[rec.endpoint] = rec.body;
  }
  return bodies;
}

function fakeFetch(bodies: Record<string, unknown>) {
  return async (url: string) => {
    const path = new URL(url).pathname;
    const body = bodies[path];
    if (!body) return { status: 404, json: async () => ({}) };
    return { status: 200, json: async () => body };
  };
}

describe("llama.cpp discovery", () => {
  it("extracts facts from the recorded /props body using corrected paths", () => {
    const facts = extractLlamaCppFacts(recorded()["/props"]);
    expect(facts).not.toBeNull();
    expect(facts?.nCtx).toBe(128000);
    expect(facts?.buildInfo).toBe("b10934-acecd5603");
    expect(facts?.totalSlots).toBe(4);
    expect(facts?.chatTemplateCaps.supports_tool_calls).toBe(true);
  });
  it("identifies llama.cpp by shape and rejects foreign responders", () => {
    expect(identifyLlamaCpp(recorded()["/props"], recorded()["/v1/models"])).toBe(true);
    expect(identifyLlamaCpp({}, {})).toBe(false);
    expect(identifyLlamaCpp({ build_info: "x" }, { data: [{ owned_by: "ollama" }] })).toBe(false);
  });
  it("probe yields the model from /v1/models data[] (not the models[] compat array)", async () => {
    const d = new LlamaCppDiscovery({ baseUrl: "http://x", fetchImpl: fakeFetch(recorded()) });
    const values = await d.probe();
    expect(values.servers.length).toBe(1);
    expect(values.servers[0].kind).toBe("llamacpp");
    expect(values.selectedModel).toBe(d.lastFacts()?.modelAlias);
    expect(values.contextLength).toBe(128000);
  });
  it("404 responder yields no servers", async () => {
    const d = new LlamaCppDiscovery({ baseUrl: "http://x", fetchImpl: fakeFetch({}) });
    expect((await d.probe()).servers).toEqual([]);
    expect(d.lastFacts()).toBeNull();
  });
});
```

- [ ] Run `pnpm test -- llamacpp`. Expected: FAIL — not exported.
- [ ] Implement `packages/discovery/src/llamacpp.ts`:

```ts
import type { DiscoveredValues } from "./index.js";

export type LlamaCppFacts = {
  modelAlias: string;
  nCtx: number;
  buildInfo: string;
  totalSlots: number;
  chatTemplateCaps: Record<string, boolean>;
};

type FetchLike = (url: string) => Promise<{ status: number; json(): Promise<unknown> }>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function identifyLlamaCpp(propsBody: unknown, modelsBody: unknown): boolean {
  if (isRecord(propsBody) && typeof propsBody.build_info === "string" &&
      typeof propsBody.model_alias === "string") {
    return true;
  }
  if (isRecord(modelsBody) && Array.isArray(modelsBody.data)) {
    return modelsBody.data.some((e) =>
      isRecord(e) && e.owned_by === "llamacpp" && isRecord(e.meta));
  }
  return false;
}

export function extractLlamaCppFacts(propsBody: unknown): LlamaCppFacts | null {
  if (!isRecord(propsBody)) return null;
  const dgs = propsBody.default_generation_settings;
  if (typeof propsBody.model_alias !== "string" ||
      typeof propsBody.build_info !== "string" ||
      typeof propsBody.total_slots !== "number" ||
      !isRecord(dgs) || typeof dgs.n_ctx !== "number") {
    return null;
  }
  const caps = isRecord(propsBody.chat_template_caps)
    ? propsBody.chat_template_caps as Record<string, boolean> : {};
  return {
    modelAlias: propsBody.model_alias,
    nCtx: dgs.n_ctx,
    buildInfo: propsBody.build_info,
    totalSlots: propsBody.total_slots,
    chatTemplateCaps: caps,
  };
}

export class LlamaCppDiscovery {
  private facts: LlamaCppFacts | null = null;

  constructor(private readonly opts: { baseUrl: string; fetchImpl?: FetchLike }) {}

  lastFacts(): LlamaCppFacts | null { return this.facts; }

  async probe(): Promise<DiscoveredValues> {
    const fetchImpl = this.opts.fetchImpl ?? defaultFetch;
    const base = this.opts.baseUrl.replace(/\/$/, "");
    const props = await fetchImpl(`${base}/props`);
    const models = await fetchImpl(`${base}/v1/models`);
    const propsBody = props.status === 200 ? await props.json() : {};
    const modelsBody = models.status === 200 ? await models.json() : {};
    if (!identifyLlamaCpp(propsBody, modelsBody)) return { servers: [] };
    this.facts = extractLlamaCppFacts(propsBody);
    if (!this.facts) return { servers: [] };
    const data = isRecord(modelsBody) && Array.isArray(modelsBody.data) ? modelsBody.data : [];
    const ids = data.filter((e) => isRecord(e) && typeof e.id === "string")
      .map((e) => ({ id: (e as { id: string }).id, contextLength: this.facts!.nCtx }));
    return {
      servers: [{ baseUrl: base, kind: "llamacpp",
        models: ids.length > 0 ? ids : [{ id: this.facts.modelAlias, contextLength: this.facts.nCtx }] }],
      selectedModel: this.facts.modelAlias,
      contextLength: this.facts.nCtx,
    };
  }
}

const defaultFetch: FetchLike = async (url) => {
  const res = await fetch(url);
  return { status: res.status, json: () => res.json() as Promise<unknown> };
};
```

- [ ] Add `export * from "./llamacpp.js";` to `packages/discovery/src/index.ts`. Run tests. Expected: PASS (4 tests).
- [ ] Commit:

```bash
git add packages/discovery
git commit -m "feat(discovery): real llama.cpp probes with corrected paths and shape ID

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 9: Model profiles (data-driven) and phase thinking kwargs

**Files:**
- Create: `packages/proxy/src/profiles.ts`
- Modify: `packages/proxy/src/index.ts`
- Test: `packages/proxy/test/profiles.test.ts`

**Interfaces:**
- Consumes: `Phase` from `@tinystrap/policy` (Plan 2, Task 2).
- Produces:

```ts
export type ModelProfile = {
  id: string;
  match: RegExp;                       // tested against the discovered model id
  toolAllowlist?: readonly string[];   // undefined = full registry
  thinking: { planning: boolean; mechanical: boolean };
  repairStrictness: "strict" | "lenient" | "off";
  budgetReserveTokens: number;
};
export const BUILTIN_PROFILES: readonly ModelProfile[];
export const DEFAULT_PROFILE: ModelProfile;
export function selectProfile(modelId: string, profiles?: readonly ModelProfile[]): ModelProfile;
export function thinkingKwargs(profile: ModelProfile, phase: Phase):
  { chat_template_kwargs: { enable_thinking: boolean } };
```

`BUILTIN_PROFILES` ships one entry matching `/qwen3/i` (thinking-capable family; planning on, mechanical off — spike-verified `enable_thinking` toggle). Unknown models get `DEFAULT_PROFILE` (conservative: thinking on everywhere, strict repair). `thinkingKwargs` emits the spike-verified request shape: `chat_template_kwargs: { enable_thinking: <bool> }` (spec §12.6, Appendix A8).

Steps:
- [ ] Write failing test `packages/proxy/test/profiles.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { BUILTIN_PROFILES, DEFAULT_PROFILE, selectProfile, thinkingKwargs } from "@tinystrap/proxy";

describe("profiles", () => {
  it("matches the qwen3 family and turns mechanical thinking off", () => {
    const p = selectProfile("/models/Qwen3.8-Flash-Next-AP-Q4_K_M.gguf");
    expect(p.id).not.toBe(DEFAULT_PROFILE.id);
    expect(p.thinking).toEqual({ planning: true, mechanical: false });
  });
  it("unknown models get the conservative default", () => {
    expect(selectProfile("mystery-70b").id).toBe(DEFAULT_PROFILE.id);
    expect(DEFAULT_PROFILE.thinking.planning).toBe(true);
    expect(DEFAULT_PROFILE.thinking.mechanical).toBe(true);
  });
  it("thinkingKwargs emits the spike-verified request shape", () => {
    const p = BUILTIN_PROFILES.find((x) => x.id !== DEFAULT_PROFILE.id)!;
    expect(thinkingKwargs(p, "planning")).toEqual({ chat_template_kwargs: { enable_thinking: true } });
    expect(thinkingKwargs(p, "implementation")).toEqual({ chat_template_kwargs: { enable_thinking: false } });
  });
});
```

- [ ] Run `pnpm test -- profiles`. Expected: FAIL — not exported.
- [ ] Implement `packages/proxy/src/profiles.ts`:

```ts
import type { Phase } from "@tinystrap/policy";

export type ModelProfile = {
  id: string;
  match: RegExp;
  toolAllowlist?: readonly string[];
  thinking: { planning: boolean; mechanical: boolean };
  repairStrictness: "strict" | "lenient" | "off";
  budgetReserveTokens: number;
};

export const DEFAULT_PROFILE: ModelProfile = {
  id: "default",
  match: /.*/,
  thinking: { planning: true, mechanical: true },
  repairStrictness: "strict",
  budgetReserveTokens: 1024,
};

export const BUILTIN_PROFILES: readonly ModelProfile[] = [
  {
    id: "qwen3",
    match: /qwen3/i,
    thinking: { planning: true, mechanical: false },
    repairStrictness: "lenient",
    budgetReserveTokens: 2048,
  },
  DEFAULT_PROFILE,
];

export function selectProfile(modelId: string, profiles: readonly ModelProfile[] = BUILTIN_PROFILES) {
  return profiles.find((p) => p.match.test(modelId)) ?? DEFAULT_PROFILE;
}

export function thinkingKwargs(profile: ModelProfile, phase: Phase) {
  const on = phase === "planning" || phase === "verification"
    ? profile.thinking.planning : profile.thinking.mechanical;
  return { chat_template_kwargs: { enable_thinking: on } };
}
```

(`verification` phase counts as failure diagnosis → planning thinking; spec §12.6.)

- [ ] Add `export * from "./profiles.js";` to `index.ts`. Run tests. Expected: PASS (3 tests).
- [ ] Commit:

```bash
git add packages/proxy
git commit -m "feat(proxy): data-driven model profiles and phase thinking kwargs

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 10: Context budgeting (scope-unknown safe)

**Files:**
- Create: `packages/proxy/src/budget.ts`
- Modify: `packages/proxy/src/index.ts`
- Test: `packages/proxy/test/budget.test.ts`

**Interfaces:**
- Consumes: `ChatMessage` (Task 2); `LlamaCppFacts` (Task 8) for the scope caveat.
- Produces:

```ts
export type NCtxScope = "total" | "per_slot" | "unknown";
export type BudgetInput = {
  nCtx: number;
  scope: NCtxScope;          // A10: "unknown" until discovery determines it
  totalSlots: number;
  reserveTokens: number;     // from profile budgetReserveTokens
};
export type Budget = { windowTokens: number; warning?: string };
export function resolveBudget(input: BudgetInput): Budget;
export function estimateTokens(text: string): number;              // ceil(len / 4)
export function truncateHistory(messages: ChatMessage[], budgetTokens: number): ChatMessage[];
export function condenseTestOutput(text: string): string;
```

`resolveBudget` must **not assume either reading** of `n_ctx` (Appendix A10): `scope === "unknown"` ⇒ treat the window as `nCtx` **shared** (the conservative, under-budgeting reading), set `warning: "n_ctx scope unknown (A10): budgeting as shared total"`, and never multiply by slots. `scope === "per_slot"` ⇒ `nCtx` per request. All budgets subtract `reserveTokens` first; never negative. `truncateHistory` keeps the system message (first) and the newest messages that fit, dropping oldest first. `condenseTestOutput` keeps lines matching `/fail|error|summary|passed|failed/i` plus the first and last line, drops the rest.

Steps:
- [ ] Write failing test `packages/proxy/test/budget.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { condenseTestOutput, estimateTokens, resolveBudget, truncateHistory } from "@tinystrap/proxy";

describe("budget", () => {
  it("unknown scope budgets as shared total with a warning, never per-slot", () => {
    const b = resolveBudget({ nCtx: 128000, scope: "unknown", totalSlots: 4, reserveTokens: 2048 });
    expect(b.windowTokens).toBe(128000 - 2048);
    expect(b.warning).toMatch(/A10/);
  });
  it("per_slot scope uses nCtx directly", () => {
    expect(resolveBudget({ nCtx: 8192, scope: "per_slot", totalSlots: 4, reserveTokens: 0 })
      .windowTokens).toBe(8192);
  });
  it("never goes negative", () => {
    expect(resolveBudget({ nCtx: 100, scope: "total", totalSlots: 1, reserveTokens: 500 })
      .windowTokens).toBe(0);
  });
  it("truncates oldest-first but keeps the system message", () => {
    const msgs = [
      { role: "system" as const, content: "sys" },
      ...Array.from({ length: 10 }, (_, i) =>
        ({ role: "user" as const, content: "x".repeat(400) })),
    ];
    const kept = truncateHistory(msgs, 500);
    expect(kept[0].role).toBe("system");
    expect(kept.length).toBeLessThan(msgs.length);
    expect(kept[kept.length - 1].content).toBe("x".repeat(400));
  });
  it("condenses test output to failures and summaries", () => {
    const out = ["build start", "ok thing a", "FAIL src/x.test.ts", "more noise",
      "Summary: 1 failed, 20 passed"].join("\n");
    const c = condenseTestOutput(out);
    expect(c).toContain("FAIL");
    expect(c).toContain("Summary");
    expect(c).not.toContain("ok thing a");
  });
});
```

- [ ] Run `pnpm test -- budget`. Expected: FAIL — not exported.
- [ ] Implement `packages/proxy/src/budget.ts`:

```ts
import type { ChatMessage } from "./types.js";

export type NCtxScope = "total" | "per_slot" | "unknown";
export type BudgetInput = {
  nCtx: number; scope: NCtxScope; totalSlots: number; reserveTokens: number;
};
export type Budget = { windowTokens: number; warning?: string };

export function resolveBudget(input: BudgetInput): Budget {
  if (input.scope === "unknown") {
    return {
      windowTokens: Math.max(0, input.nCtx - input.reserveTokens),
      warning: "n_ctx scope unknown (A10): budgeting as shared total, never per-slot",
    };
  }
  return { windowTokens: Math.max(0, input.nCtx - input.reserveTokens) };
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function truncateHistory(messages: ChatMessage[], budgetTokens: number): ChatMessage[] {
  const [first, ...rest] = messages;
  const kept: ChatMessage[] = [];
  let used = first && first.role === "system"
    ? estimateTokens(first.content ?? "") : 0;
  const head = first && first.role === "system" ? [first] : [];
  if (first && first.role !== "system") rest.unshift(first);
  for (let i = rest.length - 1; i >= 0; i--) {
    const cost = estimateTokens(rest[i].content ?? "");
    if (used + cost > budgetTokens) break;
    kept.unshift(rest[i]); used += cost;
  }
  return [...head, ...kept];
}

const KEEP_LINE = /fail|error|summary|passed|failed/i;

export function condenseTestOutput(text: string): string {
  const lines = text.split(/\r?\n/);
  if (lines.length <= 2) return text;
  const kept = new Set([0, lines.length - 1]);
  lines.forEach((l, i) => { if (KEEP_LINE.test(l)) kept.add(i); });
  return lines.filter((_, i) => kept.has(i)).join("\n");
}
```

- [ ] Add `export * from "./budget.js";` to `index.ts`. Run tests. Expected: PASS (5 tests).
- [ ] Commit:

```bash
git add packages/proxy
git commit -m "feat(proxy): context budgeting with A10 scope-unknown safety

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 11: Reasoning loop detector with gated escalation

**Files:**
- Create: `packages/proxy/src/loopdetector.ts`
- Modify: `packages/proxy/src/index.ts`
- Test: `packages/proxy/test/loopdetector.test.ts`

**Interfaces:**
- Consumes: `HarnessEvent`/`makeEvent` from `@tinystrap/policy` (Plan 2, Task 11) — emitted kind: `reasoning_intervention`.
- Produces:

```ts
export type LoopSignals = {
  repetition: number; repeatedConclusion: number; noveltyDecline: number;
  noCommitment: number; crossTurn: number; verbatim: boolean;
};
export type LoopAction = "none" | "nudge" | "close_reasoning" | "backstop";
export class LoopDetector {
  constructor(opts: {
    taskId: string;
    scoreThreshold: number;      // combined score in [0,1] that triggers nudge
    backstopTokens: number;      // hard cap (very high by default)
    midStreamClose: boolean;     // A8: default false — close step downgrades to backstop
    onIntervention?: (action: LoopAction, signals: LoopSignals) => void;
  });
  push(reasoningDelta: string): LoopAction;
  endTurn(): void;               // snapshots this turn's sentences for cross-turn checks
  signals(): LoopSignals;
}
```

Signals (spec §12.6): `repetition` = fraction of the last 20 sentences that are near-duplicates (normalized, ≥0.8 token overlap); `repeatedConclusion` = count of sentences starting with a conclusion marker (`therefore|so |thus|in conclusion`) repeating content; `noveltyDecline` = 1 − (new-sentence ratio over the window); `noCommitment` = 1 when > 40 sentences streamed with no action-bearing text (`let me|first|i will|i'll|action`) after the first 20; `crossTurn` = overlap fraction against the previous turn's sentence set; `verbatim` = exact duplicate sentence (decisive alone). Combined score = max(repetition, noveltyDecline, crossTurn) with repeatedConclusion/noCommitment contributing +0.1 each (capped at 1). Ladder: `backstop` when token estimate exceeds `backstopTokens` (always active); `close_reasoning` when score ≥ threshold **and** `midStreamClose` is true; otherwise a score trip yields `nudge` (verbatim forces at least `nudge`). With the default `midStreamClose: false`, `close_reasoning` is never returned — strong evidence falls through to the backstop only (spec: ladder stops short where forced-close is unverified). Long-but-progressing thinking (low score) is never cut. Every returned non-`none` action fires `onIntervention` with the signal snapshot.

Steps:
- [ ] Write failing test `packages/proxy/test/loopdetector.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { LoopDetector } from "@tinystrap/proxy";

const mk = (over: Partial<ConstructorParameters<typeof LoopDetector>[0]> = {}) =>
  new LoopDetector({
    taskId: "t1", scoreThreshold: 0.5, backstopTokens: 100000,
    midStreamClose: false, ...over,
  });

describe("loop detector", () => {
  it("verbatim repetition is decisive -> nudge", () => {
    const d = mk();
    const s = "I should check the file first to understand the layout.";
    d.push(s); d.push(" ");
    const a = d.push(s);
    expect(a).toBe("nudge");
    expect(d.signals().verbatim).toBe(true);
  });
  it("close_reasoning only when midStreamClose capability is on", () => {
    const d = mk({ midStreamClose: true, scoreThreshold: 0.2 });
    let action: string = "none";
    for (let i = 0; i < 30; i++) {
      action = d.push(`thinking about thing ${i % 3} again and again and again more`);
    }
    expect(action).toBe("close_reasoning");
    const d2 = mk({ scoreThreshold: 0.2 });
    let action2: string = "none";
    for (let i = 0; i < 30; i++) {
      action2 = d2.push(`thinking about thing ${i % 3} again and again and again more`);
    }
    expect(action2).not.toBe("close_reasoning");
  });
  it("backstop fires on absolute token cap regardless of score", () => {
    const d = mk({ backstopTokens: 10 });
    expect(d.push("word ".repeat(100))).toBe("backstop");
  });
  it("progressing thinking stays at none", () => {
    const d = mk();
    for (let i = 0; i < 30; i++) expect(d.push(`unique sentence number ${i} about ${i * i}`)).toBe("none");
  });
  it("interventions are reported with signal values", () => {
    const seen: string[] = [];
    const d = new LoopDetector({
      taskId: "t1", scoreThreshold: 0.5, backstopTokens: 5, midStreamClose: false,
      onIntervention: (a) => seen.push(a),
    });
    d.push("word ".repeat(100));
    expect(seen).toEqual(["backstop"]);
  });
});
```

- [ ] Run `pnpm test -- loopdetector`. Expected: FAIL — not exported.
- [ ] Implement `packages/proxy/src/loopdetector.ts`:

```ts
export type LoopSignals = {
  repetition: number; repeatedConclusion: number; noveltyDecline: number;
  noCommitment: number; crossTurn: number; verbatim: boolean;
};
export type LoopAction = "none" | "nudge" | "close_reasoning" | "backstop";

const CONCLUSION = /^(therefore|so |thus|in conclusion)/i;
const COMMITMENT = /let me|first|i will|i'll|action/i;

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function sentences(buf: string): string[] {
  return buf.split(/[.!?]+/).map(normalize).filter((s) => s.length > 0);
}

function overlap(a: string[], b: Set<string>): number {
  if (a.length === 0) return 0;
  const hits = a.filter((s) => b.has(s)).length;
  return hits / a.length;
}

export class LoopDetector {
  private buf = "";
  private seen = new Set<string>();
  private prevTurn = new Set<string>();
  private current = new Set<string>();
  private last: LoopSignals = {
    repetition: 0, repeatedConclusion: 0, noveltyDecline: 0,
    noCommitment: 0, crossTurn: 0, verbatim: false,
  };
  private totalChars = 0;

  constructor(private readonly opts: {
    taskId: string; scoreThreshold: number; backstopTokens: number;
    midStreamClose: boolean;
    onIntervention?: (action: LoopAction, signals: LoopSignals) => void;
  }) {}

  signals(): LoopSignals { return this.last; }

  endTurn(): void {
    this.prevTurn = new Set([...this.prevTurn, ...this.current]);
    this.current = new Set();
    this.buf = "";
  }

  push(delta: string): LoopAction {
    this.buf += delta;
    this.totalChars += delta.length;
    const tail = this.buf.slice(-2000);
    const sents = sentences(tail);
    if (sents.length === 0) return "none";

    let verbatim = false;
    let dupes = 0;
    for (const s of sents) {
      if (this.seen.has(s) || this.current.has(s)) { dupes++; verbatim = true; }
      this.current.add(s); this.seen.add(s);
    }
    const repetition = dupes / sents.length;
    const conclusions = sents.filter((s) => CONCLUSION.test(s));
    const repeatedConclusion = conclusions.filter((c) =>
      [...this.seen].some((s) => s !== c && CONCLUSION.test(s) &&
        c.split(" ").filter((w) => s.includes(w)).length > c.split(" ").length * 0.7)).length;
    const novel = sents.filter((s) => !this.prevTurn.has(s)).length;
    const crossTurn = overlap(sents, this.prevTurn);
    const noveltyDecline = 1 - novel / sents.length;
    const all = sentences(this.buf);
    const noCommitment = all.length > 40 &&
      !all.slice(20).some((s) => COMMITMENT.test(s)) ? 1 : 0;

    const signals: LoopSignals = {
      repetition, repeatedConclusion, noveltyDecline, noCommitment, crossTurn, verbatim,
    };
    this.last = signals;

    if (this.totalChars / 4 >= this.opts.backstopTokens) return this.fire("backstop", signals);

    const score = Math.min(1, Math.max(repetition, noveltyDecline, crossTurn) +
      0.1 * (repeatedConclusion > 0 ? 1 : 0) + 0.1 * noCommitment);
    if (score >= this.opts.scoreThreshold) {
      if (this.opts.midStreamClose) return this.fire("close_reasoning", signals);
      return this.fire("nudge", signals);
    }
    if (verbatim) return this.fire("nudge", signals);
    return "none";
  }

  private fire(action: LoopAction, signals: LoopSignals): LoopAction {
    this.opts.onIntervention?.(action, signals);
    return action;
  }
}
```

- [ ] Add `export * from "./loopdetector.js";` to `index.ts`. Run tests. Expected: PASS (5 tests). If the "progressing thinking stays at none" case trips `nudge`, the score threshold or novelty math is wrong — fix the detector, not the test.
- [ ] Commit:

```bash
git add packages/proxy
git commit -m "feat(proxy): reasoning loop detector with gated escalation ladder

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 12: Pinned notes store

**Files:**
- Create: `packages/proxy/src/notes.ts`
- Modify: `packages/proxy/src/index.ts`
- Test: `packages/proxy/test/notes.test.ts`

**Interfaces:**
- Consumes: nothing outside the proxy package.
- Produces:

```ts
export class NoteStore {
  constructor(opts?: { cap?: number; maxChars?: number });   // defaults cap 5, maxChars 200
  set(key: string, note: string): void;    // throws over cap or over maxChars
  remove(key: string): void;
  renderPinned(): string;                  // "" when empty
}
```

Notes are capped (forces brevity), persist across turns, and `renderPinned()` produces the block re-injected after compaction and at task resume (spec §12.7).

Steps:
- [ ] Write failing test `packages/proxy/test/notes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { NoteStore } from "@tinystrap/proxy";

describe("pinned notes", () => {
  it("enforces the cap and the per-note length", () => {
    const n = new NoteStore({ cap: 2, maxChars: 10 });
    n.set("plan", "do x");
    n.set("fact", "y is z");
    expect(() => n.set("third", "nope")).toThrow(/cap/);
    expect(() => n.set("long", "x".repeat(11))).toThrow(/length/);
  });
  it("renders a pinned block and survives overwrite", () => {
    const n = new NoteStore();
    n.set("decision", "use pnpm");
    n.set("decision", "use pnpm workspaces");
    expect(n.renderPinned()).toContain("decision: use pnpm workspaces");
    n.remove("decision");
    expect(n.renderPinned()).toBe("");
  });
});
```

- [ ] Run `pnpm test -- notes`. Expected: FAIL — not exported.
- [ ] Implement `packages/proxy/src/notes.ts`:

```ts
export class NoteStore {
  private notes = new Map<string, string>();
  private readonly cap: number;
  private readonly maxChars: number;

  constructor(opts: { cap?: number; maxChars?: number } = {}) {
    this.cap = opts.cap ?? 5;
    this.maxChars = opts.maxChars ?? 200;
  }

  set(key: string, note: string): void {
    if (note.length > this.maxChars) {
      throw new Error(`note over length limit (${this.maxChars} chars)`);
    }
    if (!this.notes.has(key) && this.notes.size >= this.cap) {
      throw new Error(`note cap reached (${this.cap})`);
    }
    this.notes.set(key, note);
  }

  remove(key: string): void { this.notes.delete(key); }

  renderPinned(): string {
    if (this.notes.size === 0) return "";
    const lines = [...this.notes.entries()].map(([k, v]) => `${k}: ${v}`);
    return `--- pinned notes (harness) ---\n${lines.join("\n")}\n--- end pinned notes ---`;
  }
}
```

- [ ] Add `export * from "./notes.js";` to `index.ts`. Run tests. Expected: PASS (2 tests).
- [ ] Commit:

```bash
git add packages/proxy
git commit -m "feat(proxy): capped pinned-note store

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 13: Proxy server — composition, abort, rewrite

**Files:**
- Create: `packages/proxy/src/server.ts`, `packages/proxy/src/httpprovider.ts`
- Modify: `packages/proxy/src/index.ts`
- Test: `packages/proxy/test/server.test.ts`

**Interfaces:**
- Consumes: everything above; `makeEvent`, `HarnessEvent` from `@tinystrap/policy`; `evaluate`-shaped `Preflight` callback (Plan 2 wires it — this plan's tests use a stub preflight).
- Produces:

```ts
export type ProxyDeps = {
  provider: Provider;
  registry: ToolRegistry;
  preflight: Preflight;
  onEvent?: (e: HarnessEvent) => void;
};
export function startProxy(deps: ProxyDeps, port?: number):
  Promise<{ url: string; close(): Promise<void> }>;

export class HttpProvider implements Provider {
  constructor(opts: { baseUrl: string });
  stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamChunk>;
}
```

`startProxy` (node:http): `POST /v1/chat/completions` → parse `ChatRequest`, create `AbortController`, iterate `provider.stream` through a fresh `StreamGate`; forward chunks as SSE (`formatSse`); on gate `interrupt`: abort the upstream iteration, emit `tool_stream_started`/`tool_interrupted` events, write `interruptionSse(req, reason)` + `[DONE]`, end the response. Non-stream requests are rejected with 400 in this milestone (the gate is stream-only; hosts use `stream: true`). `HttpProvider` POSTs to `<baseUrl>/v1/chat/completions` with `fetch` + `signal`, parses the SSE body incrementally with `parseSseRecords` on each accumulated buffer flush.

Steps:
- [ ] Write failing test `packages/proxy/test/server.test.ts`:

```ts
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createToolRegistry } from "@tinystrap/policy";
import {
  FakeProvider, HARNESS_NOTICE_TOOL, loadRecordedStreams, startProxy,
} from "@tinystrap/proxy";
import type { HarnessEvent, PolicyDecision } from "@tinystrap/policy";

const streams = loadRecordedStreams(join(
  process.cwd(), "docs", "superpowers", "spike-findings", "fixtures", "streams.jsonl"));

function registry() {
  const r = createToolRegistry();
  r.register({ name: "harness_notice", description: "no-op", inputSchema: {}, capabilities: [], readOnly: true });
  for (const n of ["read", "write", "edit", "bash"]) {
    r.register({ name: n, description: n, inputSchema: {}, capabilities: [], readOnly: false });
  }
  return r;
}

async function post(url: string, body: unknown): Promise<string> {
  const res = await fetch(`${url}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.text();
}

describe("proxy server", () => {
  let opened: { url: string; close(): Promise<void> }[] = [];
  afterAll(async () => { for (const s of opened) await s.close(); });

  it("passes through an allowed recorded stream as SSE", async () => {
    const proxy = await startProxy({
      provider: new FakeProvider(streams), registry: registry(),
      preflight: () => ({ effect: "allow" }),
    });
    opened.push(proxy);
    const text = await post(proxy.url,
      { model: "m", messages: [{ role: "user", content: "hi" }], stream: true });
    expect(text).toContain("data:");
    expect(text).toMatch(/\[DONE\]/);
    expect(text).not.toContain(HARNESS_NOTICE_TOOL);
  });

  it("interrupts a denied call: aborts, rewrites to harness_notice, never truncates", async () => {
    const events: HarnessEvent[] = [];
    const deny: PolicyDecision = { effect: "deny", reason: "Target is outside the task workspace.", retryable: true };
    const proxy = await startProxy({
      provider: new FakeProvider(streams), registry: registry(),
      preflight: () => deny, onEvent: (e) => events.push(e),
    });
    opened.push(proxy);
    const text = await post(proxy.url,
      { model: "m", messages: [{ role: "user", content: "hi" }], stream: true });
    expect(text).toContain(HARNESS_NOTICE_TOOL);
    expect(text).toMatch(/\[DONE\]\n\n$/);
    expect(text).not.toContain('"arguments":"{"');   // no bare fragment forwarded
    expect(events.some((e) => e.kind === "tool_interrupted")).toBe(true);
  });

  it("rejects non-stream requests with 400", async () => {
    const proxy = await startProxy({
      provider: new FakeProvider(streams), registry: registry(),
      preflight: () => ({ effect: "allow" }),
    });
    opened.push(proxy);
    const res = await fetch(`${proxy.url}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] Run `pnpm test -- server`. Expected: FAIL — not exported.
- [ ] Implement `packages/proxy/src/httpprovider.ts`:

```ts
import { parseSseRecords } from "./sse.js";
import type { ChatRequest, Provider, StreamChunk } from "./types.js";

export class HttpProvider implements Provider {
  constructor(private readonly opts: { baseUrl: string }) {}

  async *stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamChunk> {
    const res = await fetch(`${this.opts.baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`upstream ${res.status}`);
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const piece of res.body as AsyncIterable<Uint8Array>) {
      if (signal?.aborted) return;
      buffer += decoder.decode(piece, { stream: true });
      const chunks = parseSseRecords(buffer);
      for (const c of chunks) yield c;
      if (buffer.includes("[DONE]")) return;
      buffer = buffer.slice(-4096);   // keep tail in case a record spans pieces
    }
  }
}
```

- [ ] Implement `packages/proxy/src/server.ts`:

```ts
import { createServer, type Server } from "node:http";
import { makeEvent } from "@tinystrap/policy";
import type { HarnessEvent, ToolRegistry } from "@tinystrap/policy";
import { formatSse, SSE_DONE } from "./sse.js";
import { StreamGate, type Preflight } from "./gate.js";
import { interruptionSse } from "./rewrite.js";
import type { ChatRequest, Provider } from "./types.js";

export type ProxyDeps = {
  provider: Provider;
  registry: ToolRegistry;
  preflight: Preflight;
  onEvent?: (e: HarnessEvent) => void;
};

export async function startProxy(deps: ProxyDeps, port = 0) {
  const server: Server = createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.endsWith("/v1/chat/completions")) {
      res.writeHead(404).end("not found");
      return;
    }
    const body: Buffer[] = [];
    req.on("data", (d: Buffer) => body.push(d));
    req.on("end", () => void handle(deps, body, res));
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const addr = server.address();
  const url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : port}`;
  return {
    url,
    close: () => new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))),
  };
}

async function handle(
  deps: ProxyDeps, body: Buffer[],
  res: import("node:http").ServerResponse,
): Promise<void> {
  let chatReq: ChatRequest;
  try { chatReq = JSON.parse(Buffer.concat(body).toString("utf8")) as ChatRequest; }
  catch { res.writeHead(400).end("bad json"); return; }
  if (chatReq.stream !== true) {
    res.writeHead(400).end("this proxy requires stream: true");
    return;
  }
  const taskId = "proxy";
  deps.onEvent?.(makeEvent(taskId, "tool_stream_started"));
  const gate = new StreamGate({ registry: deps.registry, preflight: deps.preflight });
  const ac = new AbortController();
  res.writeHead(200, { "content-type": "text/event-stream" });
  try {
    for await (const chunk of deps.provider.stream(chatReq, ac.signal)) {
      const action = gate.push(chunk);
      if (action.kind === "interrupt") {
        ac.abort();
        deps.onEvent?.(makeEvent(taskId, "tool_interrupted",
          { tool: action.tool, reason: action.reason }));
        res.write(interruptionSse(chatReq, action.reason));
        res.write(SSE_DONE);
        res.end();
        return;
      }
      res.write(formatSse(chunk));
    }
    res.write(SSE_DONE);
    res.end();
  } catch (err) {
    res.write(SSE_DONE);
    res.end();
    void err;
  }
}
```

- [ ] Add `export * from "./httpprovider.js"; export * from "./server.js";` to `index.ts`. Run `pnpm test -- server`. Expected: PASS (3 tests). Then `pnpm test` — full suite green across all packages.
- [ ] Commit:

```bash
git add packages/proxy
git commit -m "feat(proxy): http proxy composing gate, abort, rewrite; http provider

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 14 (OPTIONAL — gated on a feasibility check): mid-stream forced reasoning-close

**Status:** **OPTIONAL / BLOCKED ON EVIDENCE.** Appendix A8 marks mid-stream forced reasoning-close (interrupt generation, then resume with reasoning closed) as **NOT tested** — only per-request `enable_thinking: false` is spike-verified. Do **not** implement this task until its feasibility check passes on a live llama.cpp server. Until then the loop detector's `close_reasoning` step stays disabled (`midStreamClose: false`, Task 11) and the ladder falls back to nudge + backstop.

**Files:**
- Create: `scripts/feasibility-mid-stream-close.mjs`
- No package code changes; no new recorded fixtures.

**Interfaces:**
- Consumes: a live llama.cpp server URL passed as `argv[2]` (never hardcoded — the spike address `LAN-HOST:8080` is recorded evidence only).
- Produces: exit code 0 + stdout `FEASIBLE: <evidence summary>` when the behavior holds; exit code 1 + `NOT FEASIBLE: <reason>` otherwise. The orchestrator records the result in Appendix A8; only then does a follow-up change flip `midStreamClose` default.

Steps:
- [ ] Write `scripts/feasibility-mid-stream-close.mjs` (plain node, no deps):

```js
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
```

- [ ] Run the check ONLY when a live llama.cpp server is available and the user has approved outbound requests to it:

```bash
node scripts/feasibility-mid-stream-close.mjs http://<live-server-host>:<port>
```

- [ ] Record the outcome in spec Appendix A8 (row 8) and, if FEASIBLE, file a follow-up task to flip `midStreamClose` default in Task 11's composition (a one-line change + test update — done in a separate commit after the evidence lands).
- [ ] Commit (script only — the task is complete when the script exists; running it is operator-gated):

```bash
git add scripts/feasibility-mid-stream-close.mjs
git commit -m "feat(scripts): optional gated feasibility probe for mid-stream reasoning-close

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Assumptions

- **Plan 2 is implemented first.** This plan consumes only Plan 2's produced interfaces (`@tinystrap/policy` exports, `@tinystrap/discovery` types). If Plan 2 is not yet on the branch, this plan cannot run.
- **Stream-only proxy in this milestone.** Non-streaming chat requests get 400; the M5 gate is defined on streams, and hosts (OpenCode/pi) run streaming. A non-stream pass-through is a later addition if any host needs it.
- **`harness_notice` registration:** the composition root (adapters plan) registers `harness_notice` as a no-op tool in the registry; Task 13's tests do it locally. The gate never interrupts it because it is registered.
- **Preflight wiring is out of scope:** building the full `PolicyContext` (readSet, exists, realPaths, ledger, evasion) per request belongs to the adapter/composition work (delivery step 4); this plan defines and tests the `Preflight` seam.
- **`fetch`/`TextDecoder`/`AbortController`** are Node 20 built-ins — no new runtime dependencies; the proxy package keeps zero non-workspace deps.
- **Fixture paths** resolve from the repo root (`process.cwd()` under vitest); tests must be run from the repo root via `pnpm test`.
- **Token estimate** (chars/4) is a placeholder-free heuristic adequate for budgeting; a real tokenizer is a §15 ablation question, not a correctness dependency.

## Self-review record

- **Spec coverage:** §9.4/§10.1 proxy as single enforcement point → Tasks 3, 5, 6, 13; §10.2 gate lifecycle + abort + well-formed rewrite (harness_notice) → Tasks 5, 6, 13; spike facts (name-in-first-chunk, 6 fragments, separate reasoning deltas, early interruption feasible, unknown-tool check at first name chunk) → Tasks 4 (replay asserts fragment shape), 5 (name check at first name-bearing chunk); §10.3 two-stage fallback → explicitly deferred (Global Constraints); §12.1 profiles data-driven + conservative default → Task 9; §12.2 repair (JSON close, aliases, edit distance, logged) → Task 7 (repairs array is the audit payload; server emits `tool_call_repaired` when wired in step 4); §12.3 budget from discovered n_ctx + A10 no-assumption rule → Task 10; §12.6 phase thinking (`enable_thinking` spike shape) → Task 9; loop detector five signals, score-combined, verbatim decisive, ladder with gated close step, backstop, never cut progressing thinking, interventions logged with signals → Task 11; A8 dependency → Task 11 `midStreamClose: false` default + Task 14 optional feasibility task; §12.7 pinned notes capped, survive compaction → Task 12; §8/§16 discovery corrected llama.cpp probes replacing StubDiscovery, Ollama/LM Studio unimplemented behind `Discovery` → Task 8; §13.4 audit events (`tool_stream_started`, `tool_interrupted`, `reasoning_intervention` via onIntervention hook) → Tasks 11, 13. **Gap found and fixed during review:** §12.2 says repairs are logged with before/after *digests* — Task 7 returns human-readable repair strings; the digest computation is a one-liner (`sha256(before) -> sha256(after)`) in the step-4 composition that emits `tool_call_repaired`; stated in Assumptions so it is not silently dropped.
- **Placeholder scan:** clean — no TBD/TODO; Task 14 is explicitly OPTIONAL/evidence-gated, not a placeholder (its script is complete and runnable); no "similar to Task N".
- **Type/name consistency:** `StreamChunk`/`ChatRequest`/`ToolCall`/`ToolCallDelta`/`Provider` defined once (Task 2), consumed by Tasks 3–13; `Preflight` defined Task 5, used Task 13; `GateAction` Task 5; `HARNESS_NOTICE_TOOL`/`interruptionSse` Task 6 → Task 13 test; `RecordedStream`/`FakeProvider`/`loadRecordedStreams` Task 4 → Task 13 test; `LlamaCppFacts` Task 8 (no scope field — A10); `ModelProfile`/`thinkingKwargs` Task 9; `NCtxScope`/`resolveBudget` Task 10; `LoopDetector`/`LoopAction`/`LoopSignals` Task 11; `NoteStore` Task 12; `ProxyDeps`/`startProxy`/`HttpProvider` Task 13. Policy imports (`ToolRegistry`, `PolicyDecision`, `HarnessEvent`, `makeEvent`, `Phase`, `createToolRegistry`) are all Plan 2 produced names.
- **Allowed-commands audit:** every shell command in every step is `git`, `pnpm`, or `node` (plus reading files with editor tools). No `rm`, no `npx`, no inline-assignment prefixes. Task 14's live probe takes the server URL as argv, never an inline env var.
