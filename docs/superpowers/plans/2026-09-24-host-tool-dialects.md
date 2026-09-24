# Host Tool Dialects Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Make the policy layer work with real host tool dialects so a real host run (opencode → proxy → model) stops interrupting every legitimate tool call and starts seeing its path/argument rules applied: a pure `HostDialect` abstraction (normalize host tool calls to the canonical vocabulary the engine, edit assistance, guidance and stall detection already speak; map canonical `rewrite` decisions back to host argument names), per-request registry seeding from the host's own `tools` array (the ground truth the request already carries), default dispositions for host tools that reach beyond the workspace (`webfetch`, `task`, `skill` denied in v1; `todowrite` allowed; `bash` analyzed by the existing shell analyzer), filtering of the forwarded `tools` array per phase/dialect (spec §9.6, "compile tool list"), and an interruption-feedback channel that does **not** depend on the host knowing a `harness_notice` tool.

**Architecture:** Two new pure modules in `@tinystrap/policy` — `dialect.ts` (the `HostDialect` interface, a generic `buildDialect` factory, and the identity/canonical dialect) and `opencode-dialect.ts` (the OpenCode dialect as data: argument-name maps, capability tags, default dispositions, all derived from `docs/superpowers/spike-findings/fixtures/opencode-tools.json`). The proxy gains a `dialect` dependency (optional, default identity, so every existing test and caller keeps working unchanged): `server.ts` seeds the shared registry from each request's `tools` array, `StreamGate` evaluates preflight on **canonical** name+args and maps `rewrite` decisions back through the dialect before the args reach the host, and guidance/stall detection consumes canonicalized calls. A new `wire.ts` compiles the forwarded `tools` array (phase allowlist ∩ dialect dispositions, plus harness-owned `pin_note` in wire format — closing the gap where the model never sees harness tools). A new `feedback.ts` carries interruption corrections into the **next request's history** (a sentinel system block, plus a `rewriteToolResult` primitive for tool-result messages keyed by `tool_call_id`), and `rewrite.ts` gains a content-based interruption that dialects without a verified `harness_notice` channel use. No new packages; no config files beyond `tinystrap.toml` (the `[host]` table shape is specified here; CLI wiring is a supervisor-plan item).

**Tech Stack:** TypeScript 5 strict ESM (NodeNext), pnpm workspaces, vitest. Node built-ins only. Tests are fixture-driven from the recorded OpenCode fixtures and `FakeProvider`/hand-built `StreamChunk[]` streams — no network, no real host binary. Same toolchain as the prior plans.

**Spec:** `docs/superpowers/specs/2026-09-20-tinystrap-harness-design.md` (§6 package layout and purity rule for `policy`, §7 single-config rule, §9.6 tool registry + capability compiler, §9.7 effects-not-tools + policy taxonomy, §10.1–10.2 proxy as single enforcement point and mid-stream rewrite, §12.2 repair / §12.5 guidance consumers of canonical names, §13.1–13.2 OpenCode/pi adapter facts, §13.5 host-mode guarantees "to verify"). Triggering evidence: `docs/superpowers/spike-findings/opencode-live-check.md` §3 F3 + F5, §5 open questions 1–2, and the fixtures beside it. Prior plans: `2026-09-22-small-model-layer-completion.md` (landed — its `feats` switches, `guidance.ts`, `notetool.ts`, and gate `rewrite` application are consumed here as-is), `2026-09-22-host-runner-and-opencode-adapter.md` (landed — `OpenCodeRunner`, live-check script).

## Global Constraints

Copied from the spec (and the task brief); these bind every task:

- **`policy` stays pure** (spec §6): `dialect.ts` and `opencode-dialect.ts` perform no filesystem, network, or process I/O — dialects are data plus pure functions. Tests may read the fixture files; `src` may not.
- **Registry seeding is the gate's ground truth fix**: the host's per-request `tools` array is what the host can actually execute; after seeding, the gate interrupts only tools that are truly unknown (live-check F3 cause 1: the live-check registry was empty, so 9 of 10 real tool calls were interrupted).
- **Canonical vocabulary is unchanged**: the engine reads `path` / `oldText` / `newText` (`engine.ts`), guidance reads `read`/`edit` + `path`/`newText` (`guidance.ts`). Dialects map **host → canonical**; nothing in `engine.ts`, `editassist.ts`, `guidance.ts`, or `loopdetector.ts` is renamed.
- **OpenCode argument facts come from the fixture, not memory** (`fixtures/opencode-tools.json`): `edit` uses `filePath`/`oldString`/`newString`/`replaceAll`; `read`/`write` use `filePath`; `bash` uses `command`/`timeout`/`workdir`; the other seven tools take no arguments the engine reads. Canonical mapping target: `path`, `oldText`, `newText`; `bash.workdir` maps to canonical arg `cwd` (consumed by the preflight wrapper as the shell-analysis cwd; see Task 5 note).
- **v1 default dispositions for reach beyond the workspace are data, not branches**: `webfetch: "deny"` (network), `task: "deny"`, `skill: "deny"` (spawn further agents), `todowrite: "allow"` (harness-neutral), everything else `"allow"` (`bash` still passes through the existing shell analyzer in `engine.ts`). Overrides live in the dialect factory (`createOpenCodeDialect(overrides)`) and, per spec §7's one-config rule, in a future `[host]` table of `tinystrap.toml`:
  ```toml
  [host]
  dialect = "opencode"        # canonical (default) | opencode
  [host.tools]                 # override dialect default dispositions
  webfetch = "allow"
  ```
  Reading that table and constructing the dialect is the supervisor/CLI's job (a later plan); this plan only provides the seam.
- **Host attribution**: every dialect assumption is attributed to a host. OpenCode facts are **verified** from the recorded fixtures. **pi's tool argument names are UNVERIFIED** (spec §13.2 verifies only the `tool_call`/`tool_result` event surface, not argument shapes) — no pi dialect is built here; when pi's names are verified, `buildDialect` is the extension point. The identity dialect (`id: "canonical"`) is correct only for hosts that already use canonical names (tinystrap's own fixture tools, the scripted stand-in).
- **`harness_notice` is not depended on**: OpenCode's behavior when the model calls a tool it does not have is **UNVERIFIED** (live-check §5 Q1 — the probe hung). Interruption feedback must work without it: content-based interruption + next-request history injection (Task 9). The unknown-tool probe stays an operator-gated feasibility task (Task 10).
- **No network in automated tests.** `FakeProvider` / hand-built `StreamChunk[]` / loopback `fetch` against `startProxy()` only, same as the existing proxy tests. No real host binary in any CI task.
- **No IP addresses, hostnames, usernames, or local paths anywhere** in code, tests, or docs (public repo; the fixtures' scrubbed placeholders like `/w/task` are the pattern).
- **Existing behavior with the identity dialect must not regress**: all current proxy/policy tests stay green unchanged; `server.ts`, `gate.ts`, `types.ts`, `features.ts`, and barrel edits are additive one-point changes, never rewrites.
- **Shared-file rule for parallel execution:** `packages/proxy/src/server.ts` is touched by groups B, C and D (each task names its exact insertion point); `packages/proxy/src/index.ts` gets one additive export line per group (B: `seed.js`, C: `wire.js`, D: `feedback.js`). `gate.ts`, `types.ts` are **B only**; `features.ts` + `features.test.ts` + `rewrite.ts` are **D only**; the two new policy files + `packages/policy/src/index.ts` are **A only**. Workers rebase on `main` before pushing and merge in the order in *Execution grouping*.
- Explicitly deferred out of scope: live-check script snapshot fix and process-tree kill (F1/F2, separate plan); loop-detector nudge cooldown (F4); adapter event-shape parser update (F5, separate plan); CLI wiring of `[host]` config; a pi dialect (argument names unverified); adapter-side `execute.before` blocking (Appendix A7).
- Shell commands in this plan use **only** the allowed set: `git`, `python`, `pnpm`, `npm`, `mkdir`, `ao`, `node`, `tinystrap`, `refdes`. **Never** `rm`, `npx`, `cd`, `for`-loops, or inline-assignment prefixes (`VAR=value cmd`) — refused by the shell whitelist; use `git -C <path>` instead of `cd`.
- Strict TDD, DRY, YAGNI, one commit per task minimum; every commit message ends with the line `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.

## Execution grouping

For the orchestrator to split work across workers/PRs.

| Group | One-liner | Size | Tasks |
| ----- | --------- | ---- | ----- |
| **A** | Pure dialect core in `@tinystrap/policy`: `HostDialect` interface + `buildDialect` factory + identity dialect + OpenCode dialect as data, fixture-tested | medium | 2 |
| **B** | Proxy consumes a dialect: `ProxyDeps.dialect`, per-request registry seeding, canonical preflight + rewrite-mapping in `StreamGate`, canonicalized calls for guidance | medium | 3 |
| **C** | Forwarded `tools` array: `toWireTool` + `compileForwardedTools` (phase allowlist ∩ dispositions) wired into the server, `pin_note` finally visible to the model in wire format | small | 2 |
| **D** | Interruption feedback without `harness_notice`: correction store, next-request history injection, `rewriteToolResult` primitive, content-based interruption, operator-gated unknown-tool probe | medium | 3 |

Dependencies and merge order (A ∥ nothing needed first; B needs A; C and D need B, then run **in parallel with each other**):

```text
A (policy) ──► B (proxy core wiring) ──┬──► C (forwarded tools)   merge: A, B, C, D
                                       └──► D (feedback channel)
```

- **`server.ts` is the hot spot** (real merge conflicts already happened there). B edits four small points (deps type, dialect+seed after budgeting, `new StreamGate({...})` opts, `completedCalls()` → guidance). C inserts one block after the pinned-notes block. D inserts one block after C's block, wraps the three `interruptionSse(...)` call sites, and threads a `corrections` parameter through `handle`. Merge **C before D** so D's worker rebases once.
- `features.ts` / `features.test.ts`: **D only** (adds `interruption_feedback`). `gate.ts` / `types.ts`: **B only**. `rewrite.ts`: **D only**. Policy files + policy barrel: **A only**.

## File Structure

| Path | Group | Responsibility (single) |
| ---- | ----- | ----------------------- |
| `packages/policy/src/dialect.ts` | A | `WireTool`, `HostToolDisposition`, `HostDialect`, `DialectSpec`, `buildDialect`, `createIdentityDialect` |
| `packages/policy/src/opencode-dialect.ts` | A | OpenCode dialect as data: arg maps, capabilities, dispositions, factory |
| `packages/policy/test/dialect.test.ts` | A | factory + identity dialect tests |
| `packages/policy/test/opencode-dialect.test.ts` | A | fixture-driven tests against `opencode-tools.json` |
| `packages/policy/src/index.ts` | A | (modify, additive) export the two new modules |
| `packages/proxy/src/types.ts` | B | (modify) `ChatRequest.tools?: WireTool[]` (wire format fix) |
| `packages/proxy/src/seed.ts` | B | `seedRegistry`, `canonicalizeCalls` |
| `packages/proxy/test/seed.test.ts` | B | seeding + canonicalization tests |
| `packages/proxy/src/gate.ts` | B | (modify) dialect-aware check: disposition, canonical preflight, rewrite mapped back |
| `packages/proxy/test/gate.test.ts` | B | (extend) dialect gate tests |
| `packages/proxy/src/server.ts` | B+C+D | **shared** — one additive wiring point per group (see tasks) |
| `packages/proxy/test/server-dialect.test.ts` | B | server-level seeding + canonical preflight through the real server |
| `packages/proxy/src/wire.ts` | C | `toWireTool`, `compileForwardedTools` |
| `packages/proxy/test/wire.test.ts` | C | forwarded-tools unit tests |
| `packages/proxy/test/server-tools-forwarding.test.ts` | C | server forwards the compiled `tools` array |
| `packages/proxy/src/feedback.ts` | D | `CorrectionStore`, `injectCorrections`, `rewriteToolResult` |
| `packages/proxy/test/feedback.test.ts` | D | feedback unit tests |
| `packages/proxy/src/rewrite.ts` | D | (modify, additive) `interruptionContentChunks` / `interruptionContentSse` |
| `packages/proxy/src/features.ts` | D | (modify, additive) `interruption_feedback` switch |
| `packages/proxy/test/features.test.ts` | D | (modify) expected key list |
| `packages/proxy/test/server-feedback.test.ts` | D | interrupt → correction in next request, content-mode interruption |
| `scripts/probe-opencode-unknown-tool.mjs` | D | operator-gated feasibility probe (no CI test) |
| `packages/proxy/src/index.ts` | B+C+D | **shared barrel** — one additive export line each |

## Interfaces consumed (verified against the code on `main`, 2026-09-24)

```ts
// @tinystrap/policy (packages/policy/src)
export function evaluate(req: ToolRequest, ctx: PolicyContext): PolicyDecision;
export type PolicyDecision =
  | { effect: "allow" }
  | { effect: "ask"; reason: string }
  | { effect: "deny"; reason: string; correction?: string; retryable: boolean }
  | { effect: "rewrite"; args: unknown; reason: string };   // applied by the gate (landed)
export type ToolRequest = { tool: string; args: Record<string, unknown>;
  cwd: string; taskId: string; phase: Phase };
export type ToolDefinition = { name: string; description: string; inputSchema: JsonSchema;
  capabilities: string[]; readOnly: boolean };
export type Phase = "planning" | "implementation" | "verification" | "promotion";
export interface ToolRegistry {
  register(def: ToolDefinition): void;   // THROWS on duplicate name (registry.ts:11)
  lookup(name: string): ToolDefinition | undefined;
  all(): ToolDefinition[];
}
export function createToolRegistry(): ToolRegistry;
export function compileToolList(phase: Phase, registry: ToolRegistry,
  allowlists?: Partial<Record<Phase, readonly string[]>>): ToolDefinition[];
  // implemented (capability.ts:4) — ZERO production consumers today (gap 2)
export function makeEvent(taskId: string, kind: HarnessEventKind,
  fields?: Partial<Omit<HarnessEvent, "taskId" | "kind" | "timestamp">>): HarnessEvent;
export const PIN_NOTE_TOOL_NAME = "pin_note";
export const PIN_NOTE_TOOL: ToolDefinition;

// @tinystrap/proxy (packages/proxy/src)
export type ChatRequest = { model: string; messages: ChatMessage[];
  tools?: ToolDefinition[];            // ← WRONG wire shape on main (gap 3); Task 3 fixes to WireTool[]
  tool_choice?: "auto" | "required" | "none"; stream?: boolean;
  chat_template_kwargs?: Record<string, unknown> };
export type ChatMessage = { role: ChatRole; content: string | null;
  tool_calls?: ToolCall[]; tool_call_id?: string };   // role "tool" + tool_call_id: see gap 4
export type ToolCall = { id: string; type: "function";
  function: { name: string; arguments: string } };
export type Preflight = (tool: string, args: Record<string, unknown>) => PolicyDecision;
export class StreamGate {
  constructor(opts: { registry: ToolRegistry; preflight: Preflight });
  push(chunk: StreamChunk): GateAction;      // GateAction: forward | interrupt {reason, tool}
  accumulated(): ToolCall[];
}
export type ProxyDeps = { provider: Provider; registry: ToolRegistry; preflight: Preflight;
  onEvent?: (e: HarnessEvent) => void; features?: Partial<ProxyFeatures>; taskId?: string;
  budgetTokens?: number; serverCaps?: Record<string, boolean> | null; phase?: () => Phase };
export async function startProxy(deps: ProxyDeps, port = 0):
  Promise<{ url: string; close(): Promise<void> }>;
export type ProxyFeatures = { tool_call_repair: boolean; context_budgeting: boolean;
  reasoning_control: boolean; edit_assistance: boolean; guidance: boolean; pinned_notes: boolean };
export const DEFAULT_FEATURES: ProxyFeatures;   // all true
export function interruptionChunks(req: ChatRequest, reason: string): StreamChunk[];
export function interruptionSse(req: ChatRequest, reason: string): string;
export const HARNESS_NOTICE_TOOL = "harness_notice";   // host behavior for it UNVERIFIED (gap 5)
export function formatSse(chunk: StreamChunk): string;
export const SSE_DONE = "data: [DONE]\n\n";
export class FakeProvider implements Provider { constructor(streams: RecordedStream[]); }
export class GuidanceState {
  constructor(opts: { taskId: string; toolCardLimit: number });
  recordCalls(calls: ToolCall[]): boolean;   // reads canonical "read"/"edit" + path/newText (gap 6)
  escalate(): StallLevel; stallCount(): number;
}

// fixtures (docs/superpowers/spike-findings/fixtures/)
// opencode-tools.json          — 10 host tools, OpenAI wire format {type:"function",function:{name,description,parameters}}
// opencode-request-shapes.json — real request bodies; tool results are role:"tool" messages keyed by tool_call_id
// opencode-run-events.jsonl    — host-side event shapes (used by the F5 parser plan, not this one)
```

## Spec-vs-code gaps found while writing this plan (audit results, report upstream)

Evidence is `file:line` on `main` (`ebad6e0`).

1. **(Audit i) Harness-owned tools are never forwarded to the model.** `server.ts:125` registers `PIN_NOTE_TOOL` in `deps.registry` only; there is **no assignment to `chatReq.tools` anywhere in `server.ts`** (grep `chatReq.tools` → 0 hits). The model can only see `pin_note` as free text inside guidance tool cards (`server.ts:117`), never as a callable entry in the `tools` array — so a constrained-decoding server will never emit it, and the pinned-notes mechanism depends on the model hallucinating a tool it was never offered. Group C fixes this by compiling and forwarding the `tools` array including harness-owned tools.
2. **(Audit ii) The capability compiler is dead code; the forwarded `tools` array is never filtered.** `compileToolList` (`policy/src/capability.ts:4`) has zero production consumers (only `capability.test.ts`). The engine's `phaseAllowlists` (`engine.ts:39–41`) only *denies at preflight time* — the model is still offered phase-forbidden and disposition-denied tools every turn, contrary to spec §9.6/§11 ("compile tool list"; unavailable tools omitted from the model request). Group C wires it.
3. **`ChatRequest.tools` has the wrong type on main.** `proxy/src/types.ts:23` declares `tools?: ToolDefinition[]`, but the wire format hosts actually send is OpenAI function format `{type:"function",function:{name,description,parameters}}` (see `fixtures/opencode-tools.json` and `opencode-request-shapes.json` `tool_count: 10`). Zero production consumers, so the fix is safe and is part of Task 3.
4. **(Audit iii) Tool results flow back as ordinary history and the proxy neither reads nor rewrites them.** `fixtures/opencode-request-shapes.json` shows the host replaying each executed call as an `assistant` message with `tool_calls` followed by a `role:"tool"` message keyed by `tool_call_id`. The proxy forwards `messages` untouched (after budgeting/guidance/notes injection), so any correction of a call the host already executed currently has no channel to reach the model. The messages are fully visible and mutable at the proxy on the *next* request — `rewriteToolResult` (Task 8) plus the correction block give that channel; Task 9 uses it for interruption feedback.
5. **(Audit iv) The interruption feedback depends on a tool the host does not know.** `rewrite.ts:4,11`: every interruption rewrites the stream into a synthetic assistant tool call to `harness_notice` with `finish_reason: "tool_calls"`. `harness_notice` is not in the host's `tools` array (fixture: 10 tools, none named that), and OpenCode's behavior on an unknown tool call is **UNVERIFIED** (live-check §5 Q1 — the probe hung at startup). The next request would then replay an assistant `tool_call` for a tool the host cannot have executed. Task 9 makes the feedback host-independent (content interruption + next-request history injection); Task 10 keeps the unknown-tool probe as an operator-gated feasibility item.
6. **Guidance/stall detection is blind to host dialects.** `guidance.ts` `recordCalls` matches `c.function.name === "read"` / `"edit"` and reads `args.path` / `args.newText`; OpenCode sends `filePath` etc. (fixture), so re-read and reverted-edit stall signals never fire for real hosts (live-check F3 cause 2). Task 5 canonicalizes calls before `recordCalls`.
7. **The live-check ran with an empty registry.** `scripts/live-host-check-opencode.mjs:58–70` passes a fresh `createToolRegistry()` with nothing registered — the direct cause of 9/10 `tool_interrupted` events (live-check §2). Per-request seeding (Task 5) makes the live-check correct without the script registering anything itself.
8. **`host_denied` extends the §9.7 taxonomy** (`unknown_tool` / `phase_denied` / `argument_denied` / `execution_error`). Disposition denials are neither unknown, phase, nor argument — Task 4 introduces the `host_denied:` reason prefix and this plan flags the taxonomy addition for the spec.

---

### Task 1 [Group A]: `HostDialect` interface, `buildDialect` factory, identity dialect

**Files:**
- Create: `packages/policy/src/dialect.ts`
- Modify: `packages/policy/src/index.ts` (one additive export line)
- Test: `packages/policy/test/dialect.test.ts`

**Interfaces:**
- Consumes: `ToolDefinition` (`policy/src/types.ts`, verified above).
- Produces (exported from `@tinystrap/policy`):

```ts
export type WireTool = {
  type: "function";
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
};
export type HostToolDisposition = "allow" | "deny";
export interface HostDialect {
  readonly id: string;
  readonly supportsHarnessNotice: boolean;   // false → proxy must use content interruption (Task 9)
  canonicalName(hostTool: string): string;
  toCanonicalArgs(hostTool: string, hostArgs: Record<string, unknown>): Record<string, unknown>;
  toHostArgs(hostTool: string, canonicalArgs: Record<string, unknown>): Record<string, unknown>;
  toolDefinition(tool: WireTool): ToolDefinition;
  disposition(hostTool: string): HostToolDisposition;
}
export type DialectSpec = {
  id: string;
  supportsHarnessNotice: boolean;
  nameMap?: Record<string, string>;                        // hostTool -> canonicalTool (absent: identity)
  argMaps: Record<string, Record<string, string>>;         // hostTool -> hostArg -> canonicalArg
  capabilities?: Record<string, string[]>;                 // hostTool -> capability tags
  readOnly?: readonly string[];                            // hostTool names that are read-only
  dispositions?: Record<string, HostToolDisposition>;      // non-default dispositions
};
export function buildDialect(spec: DialectSpec): HostDialect;
export function createIdentityDialect(): HostDialect;      // id "canonical"
```

Steps:

- [ ] Write `packages/policy/test/dialect.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildDialect, createIdentityDialect } from "@tinystrap/policy";

describe("identity dialect", () => {
  const d = createIdentityDialect();
  it("passes names and args through unchanged", () => {
    expect(d.id).toBe("canonical");
    expect(d.supportsHarnessNotice).toBe(true);
    expect(d.canonicalName("edit")).toBe("edit");
    expect(d.toCanonicalArgs("edit", { path: "/w/a", oldText: "x" }))
      .toEqual({ path: "/w/a", oldText: "x" });
    expect(d.toHostArgs("edit", { path: "/w/a", oldText: "x" }))
      .toEqual({ path: "/w/a", oldText: "x" });
  });
  it("allows everything by default", () => {
    expect(d.disposition("webfetch")).toBe("allow");
  });
  it("toolDefinition fills defaults from the wire entry", () => {
    const def = d.toolDefinition({ type: "function",
      function: { name: "read", description: "reads", parameters: { type: "object" } } });
    expect(def).toEqual({ name: "read", description: "reads",
      inputSchema: { type: "object" }, capabilities: [], readOnly: false });
  });
});

describe("buildDialect with argument maps", () => {
  const d = buildDialect({ id: "demo", supportsHarnessNotice: false,
    argMaps: { edit: { filePath: "path", oldString: "oldText" } },
    readOnly: ["read"], dispositions: { webfetch: "deny" } });
  it("maps host args to canonical args, leaving unmapped keys alone", () => {
    expect(d.toCanonicalArgs("edit", { filePath: "/w/a", oldString: "x", replaceAll: true }))
      .toEqual({ path: "/w/a", oldText: "x", replaceAll: true });
  });
  it("maps canonical rewrite args back to host names (inverse map)", () => {
    expect(d.toHostArgs("edit", { path: "/w/a", oldText: "y", replaceAll: true }))
      .toEqual({ filePath: "/w/a", oldString: "y", replaceAll: true });
  });
  it("tools without an entry pass through", () => {
    expect(d.toCanonicalArgs("bash", { command: "ls" })).toEqual({ command: "ls" });
  });
  it("carries capabilities, readOnly and dispositions from the spec", () => {
    expect(d.disposition("webfetch")).toBe("deny");
    expect(d.disposition("edit")).toBe("allow");
    expect(d.toolDefinition({ type: "function", function: { name: "read" } }))
      .toMatchObject({ readOnly: true, capabilities: [] });
  });
  it("applies nameMap when present", () => {
    const n = buildDialect({ id: "nm", supportsHarnessNotice: true, argMaps: {},
      nameMap: { read_file: "read" } });
    expect(n.canonicalName("read_file")).toBe("read");
    expect(n.canonicalName("bash")).toBe("bash");
  });
});
```

- [ ] Run `pnpm test -- dialect`. Expected: FAIL — `buildDialect`/`createIdentityDialect` not exported from `@tinystrap/policy`.
- [ ] Implement `packages/policy/src/dialect.ts`:

```ts
import type { ToolDefinition } from "./types.js";

// One entry of the `tools` array as a host sends it on the wire (OpenAI function
// format — verified against fixtures/opencode-tools.json; NOT the ToolDefinition
// shape main's ChatRequest.tools wrongly declares, see plan gap 3).
export type WireTool = {
  type: "function";
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
};

export type HostToolDisposition = "allow" | "deny";

// Pure host/canonical bridge: no I/O (spec §6 purity rule for this package).
export interface HostDialect {
  readonly id: string;
  readonly supportsHarnessNotice: boolean;
  canonicalName(hostTool: string): string;
  toCanonicalArgs(hostTool: string, hostArgs: Record<string, unknown>): Record<string, unknown>;
  toHostArgs(hostTool: string, canonicalArgs: Record<string, unknown>): Record<string, unknown>;
  toolDefinition(tool: WireTool): ToolDefinition;
  disposition(hostTool: string): HostToolDisposition;
}

export type DialectSpec = {
  id: string;
  supportsHarnessNotice: boolean;
  nameMap?: Record<string, string>;
  argMaps: Record<string, Record<string, string>>;
  capabilities?: Record<string, string[]>;
  readOnly?: readonly string[];
  dispositions?: Record<string, HostToolDisposition>;
};

function rename(map: Record<string, string>, args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) out[map[k] ?? k] = v;
  return out;
}

function invert(map: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [from, to] of Object.entries(map)) out[to] = from;
  return out;
}

export function buildDialect(spec: DialectSpec): HostDialect {
  return {
    id: spec.id,
    supportsHarnessNotice: spec.supportsHarnessNotice,
    canonicalName: (hostTool) => spec.nameMap?.[hostTool] ?? hostTool,
    toCanonicalArgs: (hostTool, hostArgs) => rename(spec.argMaps[hostTool] ?? {}, hostArgs),
    toHostArgs: (hostTool, canonicalArgs) => rename(invert(spec.argMaps[hostTool] ?? {}), canonicalArgs),
    toolDefinition: (tool) => ({
      name: tool.function.name,
      description: tool.function.description ?? "",
      inputSchema: tool.function.parameters ?? {},
      capabilities: spec.capabilities?.[tool.function.name] ?? [],
      readOnly: spec.readOnly?.includes(tool.function.name) ?? false,
    }),
    disposition: (hostTool) => spec.dispositions?.[hostTool] ?? "allow",
  };
}

// Correct for hosts that already speak the canonical vocabulary (tinystrap's own
// fixture tools, the scripted stand-in). pi is NOT known to be canonical — its
// argument names are unverified (spec 13.2); do not use this for pi until verified.
export function createIdentityDialect(): HostDialect {
  return buildDialect({ id: "canonical", supportsHarnessNotice: true, argMaps: {} });
}
```

- [ ] Add to `packages/policy/src/index.ts`: `export * from "./dialect.js";`
- [ ] Run `pnpm test` + `pnpm typecheck`. Expected: PASS.
- [ ] Commit:

```bash
git add packages/policy/src/dialect.ts packages/policy/src/index.ts packages/policy/test/dialect.test.ts
git commit -m "feat(policy): HostDialect interface, dialect factory, and identity dialect

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2 [Group A]: OpenCode dialect as data (fixture-tested)

**Files:**
- Create: `packages/policy/src/opencode-dialect.ts`
- Modify: `packages/policy/src/index.ts` (one additive export line)
- Test: `packages/policy/test/opencode-dialect.test.ts`

**Interfaces:**
- Consumes: `buildDialect`, `HostDialect`, `HostToolDisposition`, `WireTool` (Task 1); `evaluate`, `createToolRegistry`, `ToolRequest` (`policy`) for the integration assertion; fixture `docs/superpowers/spike-findings/fixtures/opencode-tools.json`.
- Produces (exported from `@tinystrap/policy`):

```ts
export function createOpenCodeDialect(
  overrides?: Record<string, HostToolDisposition>,
): HostDialect;
export const OPENCODE_DISPOSITIONS: Record<string, HostToolDisposition>;
```

Steps:

- [ ] Write `packages/policy/test/opencode-dialect.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createOpenCodeDialect, createToolRegistry, createIdentityDialect, evaluate,
} from "@tinystrap/policy";
import type { WireTool } from "@tinystrap/policy";

const fixturePath = fileURLToPath(
  new URL("../../../docs/superpowers/spike-findings/fixtures/opencode-tools.json", import.meta.url));
const hostTools = JSON.parse(readFileSync(fixturePath, "utf8")) as WireTool[];
const dialect = createOpenCodeDialect();

describe("opencode dialect vs the recorded fixture", () => {
  it("the fixture carries the 10 tools from the live check", () => {
    expect(hostTools.map((t) => t.function.name).sort()).toEqual(
      ["bash", "edit", "glob", "grep", "read", "skill", "task", "todowrite", "webfetch", "write"]);
  });
  it("every fixture entry seeds a valid ToolDefinition", () => {
    for (const t of hostTools) {
      const def = dialect.toolDefinition(t);
      expect(def.name).toBe(t.function.name);
      expect(def.description.length).toBeGreaterThan(0);
      expect(Object.keys(def.inputSchema)).toContain("properties");
    }
    expect(dialect.toolDefinition(
      hostTools.find((t) => t.function.name === "read")!).readOnly).toBe(true);
    expect(dialect.toolDefinition(
      hostTools.find((t) => t.function.name === "edit")!).readOnly).toBe(false);
    expect(dialect.toolDefinition(
      hostTools.find((t) => t.function.name === "webfetch")!.function.name === "webfetch"
      ? hostTools.find((t) => t.function.name === "webfetch")!
      : hostTools[0]).capabilities).toContain("network");
  });
  it("edit/read/write/bash argument names normalize to the canonical vocabulary", () => {
    expect(dialect.toCanonicalArgs("edit",
      { filePath: "/w/task/a.txt", oldString: "wrld", newString: "hello world", replaceAll: false }))
      .toEqual({ path: "/w/task/a.txt", oldText: "wrld", newText: "hello world", replaceAll: false });
    expect(dialect.toCanonicalArgs("read", { filePath: "/w/task/a.txt" }))
      .toEqual({ path: "/w/task/a.txt" });
    expect(dialect.toCanonicalArgs("write", { content: "x", filePath: "/w/task/a.txt" }))
      .toEqual({ content: "x", path: "/w/task/a.txt" });
    expect(dialect.toCanonicalArgs("bash", { command: "ls", workdir: "/w/task" }))
      .toEqual({ command: "ls", cwd: "/w/task" });
  });
  it("rewrite args map back to the names OpenCode executes", () => {
    expect(dialect.toHostArgs("edit", { path: "/w/task/a.txt", oldText: "wrld", newText: "x" }))
      .toEqual({ filePath: "/w/task/a.txt", oldString: "wrld", newString: "x" });
  });
  it("v1 dispositions: webfetch/task/skill denied, the rest allowed", () => {
    for (const n of ["webfetch", "task", "skill"]) expect(dialect.disposition(n)).toBe("deny");
    for (const n of ["bash", "edit", "glob", "grep", "read", "todowrite", "write"])
      expect(dialect.disposition(n)).toBe("allow");
  });
  it("overrides flip dispositions (config seam, spec 7 [host.tools])", () => {
    const d = createOpenCodeDialect({ webfetch: "allow" });
    expect(d.disposition("webfetch")).toBe("allow");
    expect(d.disposition("task")).toBe("deny");
  });
  it("the engine sees OpenCode paths after normalization", () => {
    const registry = createToolRegistry();
    for (const t of hostTools) registry.register(dialect.toolDefinition(t));
    const req: ToolRequest = { tool: "read",
      args: dialect.toCanonicalArgs("read", { filePath: "/outside/a.txt" }),
      cwd: "/w/task", taskId: "t", phase: "implementation" };
    const decision = evaluate(req, { workspaceRoot: "/w/task", registry, readSet: new Set(),
      exists: () => false, realPaths: new Map(),
      ledger: { /* ScriptLedger stub not needed: no denial signature */ } as never,
      evasion: { check: () => ({ flagged: false }) } as never });
    expect(decision.effect).toBe("deny");
    expect((decision as { reason: string }).reason).toContain("outside the task workspace");
  });
  it("does not claim the harness_notice channel (live-check 5 Q1 unverified)", () => {
    expect(dialect.supportsHarnessNotice).toBe(false);
    expect(createIdentityDialect().supportsHarnessNotice).toBe(true);
  });
});
```

(`import type { ToolRequest } from "@tinystrap/policy";` at the top with the other types.)

- [ ] Run `pnpm test -- opencode-dialect`. Expected: FAIL — `createOpenCodeDialect` not exported.
- [ ] Implement `packages/policy/src/opencode-dialect.ts`:

```ts
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
```

- [ ] Add to `packages/policy/src/index.ts`: `export * from "./opencode-dialect.js";`
- [ ] Run `pnpm test` + `pnpm typecheck`. Expected: PASS.
- [ ] Commit:

```bash
git add packages/policy/src/opencode-dialect.ts packages/policy/src/index.ts packages/policy/test/opencode-dialect.test.ts
git commit -m "feat(policy): OpenCode host dialect as fixture-tested data

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3 [Group B]: Wire-format `ChatRequest.tools` + `seedRegistry`

**Files:**
- Modify: `packages/proxy/src/types.ts` (`tools?: WireTool[]`)
- Create: `packages/proxy/src/seed.ts`
- Modify: `packages/proxy/src/index.ts` (add `export * from "./seed.js";`)
- Test: `packages/proxy/test/seed.test.ts`

**Interfaces:**
- Consumes: `HostDialect`, `WireTool`, `ToolRegistry` (`@tinystrap/policy`, Tasks 1–2); `ToolCall` (`proxy/src/types.ts`).
- Produces (exported from `@tinystrap/proxy`):

```ts
export function seedRegistry(
  registry: ToolRegistry, tools: readonly WireTool[] | undefined, dialect: HostDialect,
): number;   // count registered; entries already present are skipped (register() throws on duplicates)
export function canonicalizeCalls(dialect: HostDialect, calls: readonly ToolCall[]): ToolCall[];
```

`ChatRequest.tools` changes from `ToolDefinition[]` to `WireTool[]` (gap 3; zero production consumers — verified by `pnpm typecheck` after the change).

Steps:

- [ ] Write `packages/proxy/test/seed.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createIdentityDialect, createOpenCodeDialect, createToolRegistry } from "@tinystrap/policy";
import type { WireTool } from "@tinystrap/policy";
import { canonicalizeCalls, seedRegistry } from "@tinystrap/proxy";

const fixturePath = fileURLToPath(
  new URL("../../../docs/superpowers/spike-findings/fixtures/opencode-tools.json", import.meta.url));
const hostTools = JSON.parse(readFileSync(fixturePath, "utf8")) as WireTool[];

describe("seedRegistry", () => {
  it("registers every host tool from the fixture", () => {
    const registry = createToolRegistry();
    expect(seedRegistry(registry, hostTools, createOpenCodeDialect())).toBe(10);
    for (const t of hostTools) expect(registry.lookup(t.function.name)).toBeDefined();
  });
  it("is idempotent: a second seed adds nothing and does not throw", () => {
    const registry = createToolRegistry();
    seedRegistry(registry, hostTools, createOpenCodeDialect());
    expect(seedRegistry(registry, hostTools, createOpenCodeDialect())).toBe(0);
  });
  it("treats an absent tools array as nothing to seed", () => {
    const registry = createToolRegistry();
    expect(seedRegistry(registry, undefined, createIdentityDialect())).toBe(0);
  });
});

describe("canonicalizeCalls", () => {
  it("rewrites host calls into the canonical vocabulary for guidance/stall detection", () => {
    const [call] = canonicalizeCalls(createOpenCodeDialect(), [{
      id: "call_1", type: "function",
      function: { name: "edit",
        arguments: "{\"filePath\":\"/w/task/a.txt\",\"oldString\":\"wrld\",\"newString\":\"x\"}" },
    }]);
    expect(call.function.name).toBe("edit");
    expect(JSON.parse(call.function.arguments))
      .toEqual({ path: "/w/task/a.txt", oldText: "wrld", newText: "x" });
  });
  it("survives unparseable arguments", () => {
    const [call] = canonicalizeCalls(createOpenCodeDialect(), [{
      id: "call_2", type: "function", function: { name: "read", arguments: "{oops" },
    }]);
    expect(JSON.parse(call.function.arguments)).toEqual({});
  });
});
```

- [ ] Run `pnpm test -- seed`. Expected: FAIL — `seedRegistry`/`canonicalizeCalls` not exported.
- [ ] Implement `packages/proxy/src/seed.ts`:

```ts
import type { HostDialect, ToolRegistry, WireTool } from "@tinystrap/policy";
import type { ToolCall } from "./types.js";

// The request's own `tools` array is ground truth for what the host can execute
// (live-check F3 cause 1). Duplicate entries are skipped: registry.register throws.
export function seedRegistry(
  registry: ToolRegistry, tools: readonly WireTool[] | undefined, dialect: HostDialect,
): number {
  if (!tools) return 0;
  let added = 0;
  for (const tool of tools) {
    const name = tool?.function?.name;
    if (!name || registry.lookup(name)) continue;
    registry.register(dialect.toolDefinition(tool));
    added++;
  }
  return added;
}

function parseArgs(raw: string): Record<string, unknown> {
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
}

// For consumers that read the canonical vocabulary (guidance.recordCalls, stall
// detection): rewrite host calls without touching the bytes that go to the host.
export function canonicalizeCalls(dialect: HostDialect, calls: readonly ToolCall[]): ToolCall[] {
  return calls.map((c) => ({
    ...c,
    function: {
      name: dialect.canonicalName(c.function.name),
      arguments: JSON.stringify(dialect.toCanonicalArgs(c.function.name, parseArgs(c.function.arguments))),
    },
  }));
}
```

- [ ] In `packages/proxy/src/types.ts`: change `tools?: ToolDefinition[];` to `tools?: WireTool[];`, replace the `ToolDefinition` import with `import type { WireTool } from "@tinystrap/policy";` (no other `ToolDefinition` use remains in that file — verify with the compiler).
- [ ] Add to `packages/proxy/src/index.ts`: `export * from "./seed.js";`
- [ ] Run `pnpm test` + `pnpm typecheck`. Expected: PASS (if any test constructed `ChatRequest` with `ToolDefinition[]`-shaped tools, fix it to the wire shape — expected: none do).
- [ ] Commit:

```bash
git add packages/proxy/src/types.ts packages/proxy/src/seed.ts packages/proxy/src/index.ts packages/proxy/test/seed.test.ts
git commit -m "feat(proxy): registry seeding from the request tools array and wire-format fix

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4 [Group B]: `StreamGate` evaluates canonical form and maps rewrites back

**Files:**
- Modify: `packages/proxy/src/gate.ts`
- Test: `packages/proxy/test/gate.test.ts` (extend the existing file)

**Interfaces:**
- Consumes: `HostDialect`, `createIdentityDialect` (Task 1); `Preflight`, `GateAction` (unchanged signatures).
- Produces: `StreamGate` constructor opts gain `dialect?: HostDialect` (default `createIdentityDialect()`); behavior otherwise unchanged. New reason prefix `host_denied:` (gap 8).

Gate `check(part)` becomes: disposition check → `preflight(canonicalName, toCanonicalArgs(parsed))` → on `rewrite`, `part.args = JSON.stringify(toHostArgs(name, decision.args))`.

Steps:

- [ ] Extend `packages/proxy/test/gate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createOpenCodeDialect, createToolRegistry } from "@tinystrap/policy";
import type { PolicyDecision, WireTool } from "@tinystrap/policy";
import { seedRegistry, StreamGate } from "@tinystrap/proxy";
import type { StreamChunk } from "@tinystrap/proxy";

function toolCallChunk(index: number, id: string, name: string, args: string): StreamChunk {
  return { choices: [{ index: 0,
    delta: { role: "assistant", tool_calls: [{ index, id, function: { name, arguments: args } }] },
    finish_reason: null }] };
}

const opencodeTools: WireTool[] = [
  { type: "function", function: { name: "edit", parameters: {} } },
  { type: "function", function: { name: "webfetch", parameters: {} } },
];

function opencodeGate(decision: PolicyDecision, seen: Array<{ tool: string; args: Record<string, unknown> }>) {
  const registry = createToolRegistry();
  seedRegistry(registry, opencodeTools, createOpenCodeDialect());
  return new StreamGate({ registry, dialect: createOpenCodeDialect(),
    preflight: (tool, args) => { seen.push({ tool, args }); return decision; } });
}

describe("StreamGate with the OpenCode dialect", () => {
  it("preflight sees canonical args, not filePath/oldString", () => {
    const seen: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const gate = opencodeGate({ effect: "allow" }, seen);
    gate.push(toolCallChunk(0, "call_1", "edit",
      "{\"filePath\":\"/w/task/a.txt\",\"oldString\":\"wrld\",\"newString\":\"x\"}"));
    expect(gate.push(toolCallChunk(0, "call_1", "", "}"))).toEqual(
      expect.objectContaining({ kind: "forward" }));
    expect(seen[0].args).toEqual({ path: "/w/task/a.txt", oldText: "wrld", newText: "x" });
  });
  it("a rewrite decision is mapped back to host argument names", () => {
    const seen: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const gate = opencodeGate(
      { effect: "rewrite", reason: "edit_assistance",
        args: { path: "/w/task/a.txt", oldText: "wrld exact", newText: "x" } }, seen);
    gate.push(toolCallChunk(0, "call_1", "edit", "{\"filePath\":\"/w/task/a.txt\"}"));
    gate.push(toolCallChunk(0, "call_1", "", ",\"oldString\":\"wrld\",\"newString\":\"x\"}"));
    const [call] = gate.accumulated();
    expect(JSON.parse(call.function.arguments)).toEqual({
      filePath: "/w/task/a.txt", oldString: "wrld exact", newString: "x" });
  });
  it("a denied disposition trips with host_denied before preflight runs", () => {
    const seen: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const gate = opencodeGate({ effect: "allow" }, seen);
    const action = gate.push(toolCallChunk(0, "call_9", "webfetch", "{\"url\":\"https://example.invalid\"}"));
    expect(action.kind).toBe("interrupt");
    expect((action as { reason: string }).reason).toContain("host_denied");
    expect(seen.length).toBe(0);
  });
});
```

- [ ] Run `pnpm test -- gate`. Expected: FAIL — `StreamGate` opts do not accept `dialect`.
- [ ] Modify `packages/proxy/src/gate.ts`:

```ts
// import addition at top:
import { createIdentityDialect } from "@tinystrap/policy";
import type { HostDialect } from "@tinystrap/policy";

// constructor:
constructor(private readonly opts: { registry: ToolRegistry; preflight: Preflight; dialect?: HostDialect }) {}
private readonly dialect: HostDialect = opts.dialect ?? createIdentityDialect();
```

(declare `dialect` after the constructor parameter property; TS allows referencing `opts` there.)

Replace the body of `check` between the JSON parse and the preflight call:

```ts
private check(part: Partial): GateAction | undefined {
  if (!part.name) return undefined;
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(part.args) as Record<string, unknown>; }
  catch { parsed = { _raw: part.args }; }
  if (this.dialect.disposition(part.name) === "deny") {
    return this.trip(
      `host_denied: \`${part.name}\` is disabled by the host tool policy profile.`, part.name);
  }
  const d = this.opts.preflight(
    this.dialect.canonicalName(part.name), this.dialect.toCanonicalArgs(part.name, parsed));
  if (d.effect === "rewrite") {
    part.args = JSON.stringify(
      this.dialect.toHostArgs(part.name, d.args as Record<string, unknown>));
    return undefined;
  }
  if (d.effect === "deny" || d.effect === "ask") {
    return this.trip(d.reason, part.name);
  }
  return undefined;
}
```

- [ ] Run `pnpm test` + `pnpm typecheck`. Expected: PASS — all pre-existing gate tests (identity default) stay green.
- [ ] Commit:

```bash
git add packages/proxy/src/gate.ts packages/proxy/test/gate.test.ts
git commit -m "feat(proxy): gate evaluates canonical form and maps rewrites back to host args

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5 [Group B]: Server wiring — `ProxyDeps.dialect`, per-request seeding, canonical guidance

**Files:**
- Modify: `packages/proxy/src/server.ts` (four additive points, listed below)
- Test: `packages/proxy/test/server-dialect.test.ts`

**Interfaces:**
- Consumes: `createIdentityDialect` (Task 1), `seedRegistry`, `canonicalizeCalls` (Task 3), dialect-aware `StreamGate` (Task 4), `FakeProvider`/`RecordedStream`, `startProxy`.
- Produces: `ProxyDeps` gains (additive):

```ts
dialect?: HostDialect;   // default createIdentityDialect(); the supervisor constructs
                         // createOpenCodeDialect(...) from tinystrap.toml [host] (later plan)
```

Wiring points inside `handle` (and `startProxy` for the store in Task 9 — not here):

1. `ProxyDeps` type: add `dialect?: HostDialect;`.
2. After the `context_budgeting` block (`server.ts:107–109`), before `new GuidanceState`:

```ts
const dialect = deps.dialect ?? createIdentityDialect();
seedRegistry(deps.registry, chatReq.tools, dialect);
```

3. `new StreamGate({ registry: deps.registry, preflight: deps.preflight })` (`server.ts:129`) → add `dialect`.
4. `guidance.recordCalls(completedCalls())` → `guidance.recordCalls(canonicalizeCalls(dialect, completedCalls()))`.

Note for the caller-side preflight (not changed here): the canonical `cwd` arg from `bash.workdir` is consumed by whoever builds `preflight` — the live-check/supervisor wrapper should use `String(args.cwd ?? workspaceDir)` as `ToolRequest.cwd`. That wrapper change ships with the live-check fix plan (F1); nothing in this plan breaks if it lands later, because `workdir` is currently absent from observed calls.

Steps:

- [ ] Write `packages/proxy/test/server-dialect.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createOpenCodeDialect, createToolRegistry } from "@tinystrap/policy";
import type { PolicyDecision, WireTool } from "@tinystrap/policy";
import { startProxy } from "@tinystrap/proxy";
import type { ChatRequest, Provider, StreamChunk } from "@tinystrap/proxy";

class CapturingProvider implements Provider {
  seen: ChatRequest[] = [];
  constructor(private readonly chunks: StreamChunk[]) {}
  async *stream(req: ChatRequest): AsyncIterable<StreamChunk> {
    this.seen.push(req);
    for (const c of this.chunks) yield c;
  }
}

const hostTools: WireTool[] = [
  { type: "function", function: { name: "edit", parameters: {} } },
];

const editStream: StreamChunk[] = [
  { choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1",
    function: { name: "edit",
      arguments: "{\"filePath\":\"/w/task/a.txt\",\"oldString\":\"wrld\",\"newString\":\"hello world\"}" } }] },
    finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
];

async function post(url: string, body: unknown): Promise<Response> {
  return fetch(`${url}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

describe("server dialect wiring", () => {
  it("seeds the registry from the request: an OpenCode edit is not interrupted", async () => {
    const seen: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const provider = new CapturingProvider(editStream);
    const proxy = await startProxy({
      provider, registry: createToolRegistry(),
      preflight: (tool, args): PolicyDecision => { seen.push({ tool, args }); return { effect: "allow" }; },
      dialect: createOpenCodeDialect(), taskId: "t",
    });
    const res = await post(proxy.url, { model: "m", stream: true, tools: hostTools,
      messages: [{ role: "user", content: "go" }] });
    const text = await res.text();
    await proxy.close();
    expect(text).not.toContain("tool_calls\" interrupted");   // no interruption payload
    expect(text).not.toContain("harness_notice");
    expect(seen[0].args).toEqual({ path: "/w/task/a.txt", oldText: "wrld", newText: "hello world" });
  });
  it("without a dialect the old behavior is untouched (identity default)", async () => {
    const provider = new CapturingProvider(editStream);
    const proxy = await startProxy({
      provider, registry: createToolRegistry(),
      preflight: () => ({ effect: "allow" }), taskId: "t",
    });
    const res = await post(proxy.url, { model: "m", stream: true, tools: hostTools,
      messages: [{ role: "user", content: "go" }] });
    const text = await res.text();
    await proxy.close();
    expect(text).toContain("harness_notice");   // unknown_tool interrupt: edit was never seeded
    expect(text).toContain("unknown_tool");
  });
});
```

- [ ] Run `pnpm test -- server-dialect`. Expected: FAIL — `ProxyDeps` has no `dialect`; the first test hits `unknown_tool`.
- [ ] Apply the four wiring edits listed above (imports: `createIdentityDialect` from `@tinystrap/policy`; `seedRegistry`, `canonicalizeCalls` are same-package `./seed.js`).
- [ ] Run `pnpm test` + `pnpm typecheck`. Expected: PASS — identity default keeps every existing server test green.
- [ ] Commit:

```bash
git add packages/proxy/src/server.ts packages/proxy/test/server-dialect.test.ts
git commit -m "feat(proxy): per-request registry seeding and canonical guidance under a dialect dep

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6 [Group C]: `toWireTool` + `compileForwardedTools`

**Files:**
- Create: `packages/proxy/src/wire.ts`
- Modify: `packages/proxy/src/index.ts` (add `export * from "./wire.js";`)
- Test: `packages/proxy/test/wire.test.ts`

**Interfaces:**
- Consumes: `compileToolList` (`@tinystrap/policy`, verified dead-code-but-correct), `HostDialect`, `Phase`, `ToolDefinition`, `ToolRegistry`, `WireTool`.
- Produces (exported from `@tinystrap/proxy`):

```ts
export function toWireTool(def: ToolDefinition): WireTool;
export function compileForwardedTools(opts: {
  registry: ToolRegistry;
  phase: Phase;
  phaseAllowlists?: Partial<Record<Phase, readonly string[]>>;
  dialect: HostDialect;
  extraTools?: readonly ToolDefinition[];   // harness-owned; bypass phase allowlist, deduped
}): WireTool[];
```

Steps:

- [ ] Write `packages/proxy/test/wire.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createOpenCodeDialect, createToolRegistry, PIN_NOTE_TOOL } from "@tinystrap/policy";
import type { ToolDefinition } from "@tinystrap/policy";
import { compileForwardedTools, toWireTool } from "@tinystrap/proxy";

function def(name: string): ToolDefinition {
  return { name, description: name, inputSchema: { type: "object" }, capabilities: [], readOnly: false };
}

function registryWith(...names: string[]) {
  const r = createToolRegistry();
  for (const n of names) r.register(def(n));
  return r;
}

describe("toWireTool", () => {
  it("maps inputSchema to the wire parameters key", () => {
    expect(toWireTool(def("read"))).toEqual({ type: "function",
      function: { name: "read", description: "read", parameters: { type: "object" } } });
  });
});

describe("compileForwardedTools", () => {
  const dialect = createOpenCodeDialect();
  it("omits disposition-denied tools from the forwarded array (spec 9.6)", () => {
    const r = registryWith("read", "edit", "webfetch", "task", "skill");
    const names = compileForwardedTools({ registry: r, phase: "implementation", dialect })
      .map((t) => t.function.name);
    expect(names.sort()).toEqual(["edit", "read"]);
  });
  it("omits phase-denied tools via compileToolList", () => {
    const r = registryWith("read", "edit");
    const names = compileForwardedTools({ registry: r, phase: "planning", dialect,
      phaseAllowlists: { planning: ["read"] } }).map((t) => t.function.name);
    expect(names).toEqual(["read"]);
  });
  it("appends harness-owned extras once, even when the phase allowlist excludes them", () => {
    const r = registryWith("read");
    const names = compileForwardedTools({ registry: r, phase: "planning", dialect,
      phaseAllowlists: { planning: ["read"] }, extraTools: [PIN_NOTE_TOOL] })
      .map((t) => t.function.name);
    expect(names).toEqual(["read", "pin_note"]);
    const r2 = registryWith("read", "pin_note");
    const names2 = compileForwardedTools({ registry: r2, phase: "implementation", dialect,
      extraTools: [PIN_NOTE_TOOL] }).map((t) => t.function.name);
    expect(names2.filter((n) => n === "pin_note")).toEqual(["pin_note"]);   // deduped
  });
});
```

- [ ] Run `pnpm test -- wire`. Expected: FAIL — `toWireTool`/`compileForwardedTools` not exported.
- [ ] Implement `packages/proxy/src/wire.ts`:

```ts
import { compileToolList } from "@tinystrap/policy";
import type { HostDialect, Phase, ToolDefinition, ToolRegistry, WireTool } from "@tinystrap/policy";

export function toWireTool(def: ToolDefinition): WireTool {
  return { type: "function",
    function: { name: def.name, description: def.description, parameters: def.inputSchema } };
}

// Spec 9.6/11: unavailable tools are omitted from the model request, not merely
// denied at preflight time. Harness-owned extras (pin_note) are always offered
// when their feature is on — the phase allowlist governs host tools.
export function compileForwardedTools(opts: {
  registry: ToolRegistry;
  phase: Phase;
  phaseAllowlists?: Partial<Record<Phase, readonly string[]>>;
  dialect: HostDialect;
  extraTools?: readonly ToolDefinition[];
}): WireTool[] {
  const compiled = compileToolList(opts.phase, opts.registry, opts.phaseAllowlists)
    .filter((t) => opts.dialect.disposition(t.name) !== "deny");
  const extras = (opts.extraTools ?? [])
    .filter((t) => !compiled.some((c) => c.name === t.name));
  return [...compiled, ...extras].map(toWireTool);
}
```

- [ ] Add to `packages/proxy/src/index.ts`: `export * from "./wire.js";`
- [ ] Run `pnpm test` + `pnpm typecheck`. Expected: PASS.
- [ ] Commit:

```bash
git add packages/proxy/src/wire.ts packages/proxy/src/index.ts packages/proxy/test/wire.test.ts
git commit -m "feat(proxy): compile the forwarded tools array from phase allowlist and dispositions

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7 [Group C]: Server forwards the compiled `tools` array (audit i + ii fix)

**Files:**
- Modify: `packages/proxy/src/server.ts` (one insertion + one `ProxyDeps` field)
- Test: `packages/proxy/test/server-tools-forwarding.test.ts`

**Interfaces:**
- Consumes: `compileForwardedTools` (Task 6); `dialect` wiring from Task 5 (this task assumes B has landed); `PIN_NOTE_TOOL`/`PIN_NOTE_TOOL_NAME`; `feats.pinned_notes`.
- Produces: `ProxyDeps` gains (additive):

```ts
phaseAllowlists?: Partial<Record<Phase, readonly string[]>>;   // same shape as PolicyContext's
```

Insertion: after the pinned-notes block (`server.ts:123–127` on main; `PIN_NOTE_TOOL` is registered there, so the compiled list carries it) and before `deps.onEvent?.(makeEvent(taskId, "tool_stream_started"))`:

```ts
// Spec 9.6/11: the model is offered exactly the tools it may use — phase-allowed,
// disposition-allowed, plus harness-owned pin_note (gap 1: on main the model
// never sees harness tools at all). Only rewrite when the host sent a tools
// array; a tools-less request stays tools-less.
if (chatReq.tools !== undefined) {
  chatReq = { ...chatReq, tools: compileForwardedTools({
    registry: deps.registry, phase: deps.phase?.() ?? "planning",
    phaseAllowlists: deps.phaseAllowlists, dialect,
    extraTools: feats.pinned_notes ? [PIN_NOTE_TOOL] : [],
  }) };
}
```

Steps:

- [ ] Write `packages/proxy/test/server-tools-forwarding.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createOpenCodeDialect, createToolRegistry } from "@tinystrap/policy";
import type { WireTool } from "@tinystrap/policy";
import { startProxy } from "@tinystrap/proxy";
import type { ChatRequest, Provider, StreamChunk } from "@tinystrap/proxy";

class CapturingProvider implements Provider {
  seen: ChatRequest[] = [];
  constructor(private readonly chunks: StreamChunk[]) {}
  async *stream(req: ChatRequest): AsyncIterable<StreamChunk> {
    this.seen.push(req);
    for (const c of this.chunks) yield c;
  }
}

const textStream: StreamChunk[] = [
  { choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
];

const hostTools: WireTool[] = ["read", "edit", "webfetch", "task", "skill"].map((name) => ({
  type: "function" as const, function: { name, description: name, parameters: {} },
}));

async function post(url: string, body: unknown): Promise<Response> {
  return fetch(`${url}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

describe("forwarded tools array", () => {
  it("drops disposition-denied tools and adds pin_note to what the model sees", async () => {
    const provider = new CapturingProvider(textStream);
    const proxy = await startProxy({ provider, registry: createToolRegistry(),
      preflight: () => ({ effect: "allow" }), dialect: createOpenCodeDialect(),
      taskId: "t", features: { guidance: false } });
    await (await post(proxy.url, { model: "m", stream: true, tools: hostTools,
      messages: [{ role: "user", content: "go" }] })).text();
    await proxy.close();
    const names = provider.seen[0].tools!.map((t) => t.function.name);
    expect(names.sort()).toEqual(["edit", "pin_note", "read"]);
  });
  it("honors the phase allowlist", async () => {
    const provider = new CapturingProvider(textStream);
    const proxy = await startProxy({ provider, registry: createToolRegistry(),
      preflight: () => ({ effect: "allow" }), dialect: createOpenCodeDialect(),
      taskId: "t", features: { guidance: false, pinned_notes: false },
      phaseAllowlists: { planning: ["read"] } });
    await (await post(proxy.url, { model: "m", stream: true, tools: hostTools,
      messages: [{ role: "user", content: "go" }] })).text();
    await proxy.close();
    const names = provider.seen[0].tools!.map((t) => t.function.name);
    expect(names).toEqual(["read"]);
  });
  it("a request without a tools array stays without one", async () => {
    const provider = new CapturingProvider(textStream);
    const proxy = await startProxy({ provider, registry: createToolRegistry(),
      preflight: () => ({ effect: "allow" }), taskId: "t", features: { guidance: false } });
    await (await post(proxy.url, { model: "m", stream: true,
      messages: [{ role: "user", content: "go" }] })).text();
    await proxy.close();
    expect(provider.seen[0].tools).toBeUndefined();
  });
});
```

- [ ] Run `pnpm test -- server-tools-forwarding`. Expected: FAIL — forwarded `tools` still equals the host array (webfetch/task/skill present, pin_note absent).
- [ ] Apply the insertion and the `ProxyDeps.phaseAllowlists` field; import `compileForwardedTools` from `./wire.js`.
- [ ] Run `pnpm test` + `pnpm typecheck`. Expected: PASS (existing server tests send no `tools` array — the third case above proves that path is a no-op).
- [ ] Commit:

```bash
git add packages/proxy/src/server.ts packages/proxy/test/server-tools-forwarding.test.ts
git commit -m "feat(proxy): forward the compiled tools array so the model sees exactly what it may call

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8 [Group D]: Correction store, history injection, tool-result rewriting

**Files:**
- Create: `packages/proxy/src/feedback.ts`
- Modify: `packages/proxy/src/index.ts` (add `export * from "./feedback.js";`)
- Test: `packages/proxy/test/feedback.test.ts`

**Interfaces:**
- Consumes: `ChatMessage` (`proxy/src/types.ts`; role `"tool"` + `tool_call_id` per gap 4).
- Produces (exported from `@tinystrap/proxy`):

```ts
export const CORRECTION_SENTINEL = "--- harness notice ---";
export class CorrectionStore {
  constructor(opts?: { max?: number });        // default max 3, oldest dropped
  add(reason: string): void;
  pending(): string[];                          // copy, oldest first
  clear(): void;
}
export function injectCorrections(messages: ChatMessage[], corrections: readonly string[]): ChatMessage[];
export function rewriteToolResult(messages: ChatMessage[], toolCallId: string, content: string): ChatMessage[];
```

Steps:

- [ ] Write `packages/proxy/test/feedback.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CORRECTION_SENTINEL, CorrectionStore, injectCorrections, rewriteToolResult } from "@tinystrap/proxy";
import type { ChatMessage } from "@tinystrap/proxy";

describe("CorrectionStore", () => {
  it("caps at max, keeping the newest", () => {
    const s = new CorrectionStore({ max: 2 });
    s.add("a"); s.add("b"); s.add("c");
    expect(s.pending()).toEqual(["b", "c"]);
    s.clear();
    expect(s.pending()).toEqual([]);
  });
});

describe("injectCorrections", () => {
  const history: ChatMessage[] = [
    { role: "system", content: "host prompt" },
    { role: "user", content: "go" },
  ];
  it("inserts a sentinel block after the leading system message", () => {
    const out = injectCorrections(history, ["unknown_tool: `bogus`"]);
    expect(out.length).toBe(3);
    expect(out[1].content!.startsWith(CORRECTION_SENTINEL)).toBe(true);
    expect(out[1].content).toContain("unknown_tool");
  });
  it("replaces the previous block instead of stacking (idempotent per request)", () => {
    const once = injectCorrections(history, ["first"]);
    const twice = injectCorrections(once, ["second"]);
    expect(twice.length).toBe(3);
    expect(twice[1].content).toContain("second");
    expect(twice[1].content).not.toContain("first");
  });
  it("empty corrections strips any stale block", () => {
    const once = injectCorrections(history, ["x"]);
    expect(injectCorrections(once, []).length).toBe(2);
  });
});

describe("rewriteToolResult", () => {
  const history: ChatMessage[] = [
    { role: "assistant", content: "", tool_calls: [{ id: "call_0", type: "function",
      function: { name: "read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_0", content: "original output" },
  ];
  it("replaces the content of the matching tool message only", () => {
    const out = rewriteToolResult(history, "call_0", "Harness: corrected output");
    expect(out[1]).toEqual({ role: "tool", tool_call_id: "call_0",
      content: "Harness: corrected output" });
    expect(out[0]).toBe(history[0]);
  });
  it("leaves history untouched when no call matches", () => {
    expect(rewriteToolResult(history, "call_9", "x")).toEqual(history);
  });
});
```

- [ ] Run `pnpm test -- feedback`. Expected: FAIL — module not exported.
- [ ] Implement `packages/proxy/src/feedback.ts`:

```ts
import type { ChatMessage } from "./types.js";

export const CORRECTION_SENTINEL = "--- harness notice ---";

// Interruptions the host never executed; injected into the NEXT request's history
// so the correction reaches the model without any harness_notice dependency
// (live-check 5 Q1: host behavior for unknown tools is unverified).
export class CorrectionStore {
  private items: string[] = [];
  constructor(private readonly opts: { max?: number } = {}) {}
  add(reason: string): void {
    this.items.push(reason);
    const max = this.opts.max ?? 3;
    if (this.items.length > max) this.items = this.items.slice(-max);
  }
  pending(): string[] { return [...this.items]; }
  clear(): void { this.items = []; }
}

export function injectCorrections(messages: ChatMessage[], corrections: readonly string[]): ChatMessage[] {
  const kept = messages.filter((m) =>
    !(m.role === "system" && typeof m.content === "string" && m.content.startsWith(CORRECTION_SENTINEL)));
  if (corrections.length === 0) return kept;
  const at = kept.length > 0 && kept[0].role === "system" ? 1 : 0;
  const block = `${CORRECTION_SENTINEL}\n${corrections.map((c) => `- ${c}`).join("\n")}\n--- end notice ---`;
  return [...kept.slice(0, at), { role: "system" as const, content: block }, ...kept.slice(at)];
}

// Primitive for gap 4: a correction of a call the host DID execute can be
// written into the replayed tool-result message on the next request.
export function rewriteToolResult(
  messages: ChatMessage[], toolCallId: string, content: string,
): ChatMessage[] {
  return messages.map((m) =>
    m.role === "tool" && m.tool_call_id === toolCallId ? { ...m, content } : m);
}
```

- [ ] Add to `packages/proxy/src/index.ts`: `export * from "./feedback.js";`
- [ ] Run `pnpm test` + `pnpm typecheck`. Expected: PASS.
- [ ] Commit:

```bash
git add packages/proxy/src/feedback.ts packages/proxy/src/index.ts packages/proxy/test/feedback.test.ts
git commit -m "feat(proxy): correction store, history injection, and tool-result rewriting primitives

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 9 [Group D]: Content-based interruption + next-request correction wiring

**Files:**
- Modify: `packages/proxy/src/rewrite.ts` (additive)
- Modify: `packages/proxy/src/features.ts` (add `interruption_feedback`)
- Modify: `packages/proxy/test/features.test.ts` (expected key list)
- Modify: `packages/proxy/src/server.ts` (corrections threading)
- Test: `packages/proxy/test/server-feedback.test.ts`

**Interfaces:**
- Consumes: `HostDialect.supportsHarnessNotice` (Task 1); `CorrectionStore`, `injectCorrections` (Task 8); existing `interruptionSse`.
- Produces (exported from `@tinystrap/proxy`):

```ts
export function interruptionContentChunks(reason: string): StreamChunk[];
export function interruptionContentSse(reason: string): string;
// ProxyFeatures gains: interruption_feedback: boolean (default true)
```

`interruption_feedback` is **not** a spec §7 mechanism — it is a plan-level switch (spec §12's "every mechanism individually switchable" principle); flag it for the §7 config table in the spec update alongside gap 8.

Steps:

- [ ] Write `packages/proxy/test/server-feedback.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createOpenCodeDialect, createToolRegistry } from "@tinystrap/policy";
import { startProxy } from "@tinystrap/proxy";
import type { ChatRequest, Provider, StreamChunk } from "@tinystrap/proxy";
import { interruptionContentSse } from "@tinystrap/proxy";

class CapturingProvider implements Provider {
  seen: ChatRequest[] = [];
  constructor(private readonly streams: StreamChunk[][]) {}
  async *stream(req: ChatRequest): AsyncIterable<StreamChunk> {
    this.seen.push(req);
    for (const c of this.streams[Math.min(this.seen.length - 1, this.streams.length - 1)]) yield c;
  }
}

const unknownToolStream: StreamChunk[] = [
  { choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_x",
    function: { name: "bogus_tool", arguments: "{}" } }] }, finish_reason: null }] },
];
const textStream: StreamChunk[] = [
  { choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
];

async function post(url: string, body: unknown): Promise<Response> {
  return fetch(`${url}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

describe("interruptionContentSse", () => {
  it("delivers the reason as assistant content with a stop, no harness_notice", () => {
    const sse = interruptionContentSse("unknown_tool: `bogus_tool`");
    expect(sse).toContain("unknown_tool");
    expect(sse).toContain("\"stop\"");
    expect(sse).not.toContain("harness_notice");
  });
});

describe("correction reaches the model via the next request", () => {
  it("opencode dialect: interrupt responds with content, next request carries the notice block", async () => {
    const provider = new CapturingProvider([unknownToolStream, textStream]);
    const proxy = await startProxy({ provider, registry: createToolRegistry(),
      preflight: () => ({ effect: "allow" }), dialect: createOpenCodeDialect(), taskId: "t" });
    const first = await (await post(proxy.url, { model: "m", stream: true,
      messages: [{ role: "user", content: "go" }] })).text();
    expect(first).toContain("unknown_tool");
    expect(first).not.toContain("harness_notice");
    await (await post(proxy.url, { model: "m", stream: true,
      messages: [{ role: "user", content: "go" }] })).text();
    await proxy.close();
    const second = provider.seen[1];
    expect(second.messages.some((msg) =>
      msg.role === "system" && (msg.content ?? "").startsWith("--- harness notice ---"))).toBe(true);
    expect(second.messages.find((msg) =>
      (msg.content ?? "").startsWith("--- harness notice ---"))!.content).toContain("bogus_tool");
  });
  it("identity dialect keeps the harness_notice channel (no regression)", async () => {
    const provider = new CapturingProvider([unknownToolStream, textStream]);
    const proxy = await startProxy({ provider, registry: createToolRegistry(),
      preflight: () => ({ effect: "allow" }), taskId: "t" });
    const first = await (await post(proxy.url, { model: "m", stream: true,
      messages: [{ role: "user", content: "go" }] })).text();
    await proxy.close();
    expect(first).toContain("harness_notice");
  });
  it("feature off: no notice block in the next request", async () => {
    const provider = new CapturingProvider([unknownToolStream, textStream]);
    const proxy = await startProxy({ provider, registry: createToolRegistry(),
      preflight: () => ({ effect: "allow" }), dialect: createOpenCodeDialect(), taskId: "t",
      features: { interruption_feedback: false } });
    await (await post(proxy.url, { model: "m", stream: true,
      messages: [{ role: "user", content: "go" }] })).text();
    await (await post(proxy.url, { model: "m", stream: true,
      messages: [{ role: "user", content: "go" }] })).text();
    await proxy.close();
    expect(provider.seen[1].messages.some((msg) =>
      (msg.content ?? "").startsWith("--- harness notice ---"))).toBe(false);
  });
});
```

- [ ] Run `pnpm test -- server-feedback`. Expected: FAIL — `interruptionContentSse` not exported; opencode interrupt still emits `harness_notice`; no notice block appears.
- [ ] Add to `packages/proxy/src/rewrite.ts`:

```ts
export function interruptionContentChunks(reason: string): StreamChunk[] {
  return [
    { choices: [{ index: 0, delta: { role: "assistant", content: `Harness: ${reason}` },
      finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
}

export function interruptionContentSse(reason: string): string {
  return interruptionContentChunks(reason).map(formatSse).join("") + SSE_DONE;
}
```

- [ ] Add `interruption_feedback: true` to `ProxyFeatures` and `DEFAULT_FEATURES` in `features.ts` (with a comment: plan-level switch, not a spec §7 mechanism — pending spec update). Update `packages/proxy/test/features.test.ts`: keep `SPEC_7_NAMES` as-is, add `const PLAN_FEATURES: (keyof ProxyFeatures)[] = ["interruption_feedback"];` and change the key-set assertion to `expect(Object.keys(DEFAULT_FEATURES).sort()).toEqual([...SPEC_7_NAMES, ...PLAN_FEATURES].sort());`; in the third test, `declared` becomes `SPEC_7_NAMES.includes(key) || PLAN_FEATURES.includes(key)`.
- [ ] Wire `server.ts`:
  - In `startProxy`: `const corrections = new CorrectionStore();` beside `const notes = new NoteStore();`; pass it: `req.on("end", () => void handle(deps, body, res, notes, corrections));` and extend the `handle` signature.
  - In `handle`, after the guidance injection block and before the pinned-notes block:

```ts
if (feats.interruption_feedback) {
  chatReq = { ...chatReq, messages: injectCorrections(chatReq.messages, corrections.pending()) };
}
```

  - Add a local helper after `const dialect = ...` (Task 5):

```ts
const interruptSse = (reason: string): string =>
  feats.interruption_feedback && !dialect.supportsHarnessNotice
    ? interruptionContentSse(reason)
    : interruptionSse(chatReq, reason);
```

  - Replace the three interruption write sites — the gate interrupt (`res.write(interruptionSse(chatReq, action.reason))` plus the loop backstop `"reasoning_backstop"` and the stall stop `"guidance: stall stop"`) — with `res.write(interruptSse(reason))`, and before each write call `corrections.add(reason)` (gate interrupts always; backstop/stall-stop also recorded — they are corrections the model should see once).
- [ ] Run `pnpm test` + `pnpm typecheck`. Expected: PASS — identity-dialect server tests keep `harness_notice` because `createIdentityDialect().supportsHarnessNotice === true`.
- [ ] Commit:

```bash
git add packages/proxy/src/rewrite.ts packages/proxy/src/features.ts packages/proxy/test/features.test.ts packages/proxy/src/server.ts packages/proxy/test/server-feedback.test.ts
git commit -m "feat(proxy): host-independent interruption feedback via content and next-request history

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 10 [Group D]: Operator-gated probe — what does OpenCode do with an unknown tool? (feasibility, UNVERIFIED)

**Files:**
- Create: `scripts/probe-opencode-unknown-tool.mjs`
- Create (by the operator, after running): `docs/superpowers/spike-findings/opencode-unknown-tool.md`

**Interfaces:**
- Consumes: `startProxy` + `HttpProvider`-style scripted responses (reuse the `live-host-check-opencode.mjs` structure — loopback guard, `--pure` headless run, timeout with process-tree kill per the F2 fix once it lands; until F2 lands the probe carries a hard wall-clock note and the operator kills the tree manually).
- Produces: a recorded answer to live-check §5 Q1. **No CI test; no automated task may run the real binary.**

This task is **operator-gated and clearly labelled**: it exists because the design decision in Task 9 must eventually be revisited — if OpenCode tolerates unknown tool calls (executes nothing, feeds an error result back to the model), the `harness_notice` channel can be re-enabled for it and the correction block becomes a belt-and-braces second channel. If it hangs or crashes the host (the previous probe attempt did hang at startup, live-check §5 Q2), the content-based path stays the only one.

Steps:

- [ ] Write `scripts/probe-opencode-unknown-tool.mjs`: start the proxy with a scripted provider that replies to request #1 with a `harness_notice` tool call (`interruptionChunks` shape) and to every later request with a plain "stop" text stream; run `opencode run --format json --pure` through `OpenCodeRunner` with a trivial prompt; capture: (a) does the host exit cleanly, error, or hang; (b) does request #2 contain a `role:"tool"` message for the `harness_notice` call and what does it say; (c) the exact exit code. Print all three. Header comment: `OPERATOR-GATED FEASIBILITY PROBE — runs the real opencode binary; never in CI. Answers live-check section 5 question 1.`
- [ ] Run `node --check scripts/probe-opencode-unknown-tool.mjs`. Expected: OK.
- [ ] **Manual run (operator):** execute against a local server; record the outcome verbatim in `docs/superpowers/spike-findings/opencode-unknown-tool.md`, including whether the startup stall from live-check §5 Q2 reproduced.
- [ ] Commit (operator, separate commit): `docs(spike): opencode unknown-tool behavior recorded (live-check 5 Q1)`

---

## Verification (whole plan)

- `pnpm test` — all packages green; **no network** (FakeProvider / loopback fetch only), **no real host binary** in CI.
- `pnpm typecheck` — includes `adapters/opencode` and `adapters/pi` (unchanged by this plan).
- Fixture gate: `packages/policy/test/opencode-dialect.test.ts` and `packages/proxy/test/seed.test.ts` read the recorded fixtures directly — if a future refactor drifts the dialect away from what OpenCode actually sends, CI catches it.
- Regression gate: every pre-existing proxy test passes with no edits (identity dialect default); the two intentional test-file edits in this plan are `gate.test.ts` (extension), `features.test.ts` (key list), and `seed.test.ts`/new files.
- Sensitive-string gate before any push: scan changed files against the project's sensitive-pattern list (private LAN prefix, operator account strings, local absolute paths, personal emails — the list from the task brief, not repeated here) → 0 hits.
- Follow-up (not in this plan): re-run `scripts/live-host-check-opencode.mjs` after F1/F2/F5 fixes land + this plan; expected: `tool_interrupted` count drops to only genuinely-illegal calls, and `edit_assistance` rewrites reach OpenCode under `filePath`/`oldString`/`newString`.

## Self-review record

- **Spec coverage:** registry seeding + dialect normalization (live-check F3, spec §9.7 effects vocabulary preserved) → Tasks 1–5; forwarded-tools filtering (spec §9.6/§11, audit ii) and harness-tool visibility (audit i) → Tasks 6–7; feedback without `harness_notice` (spec §10.2's "assistant message carrying the correction text" alternative; audit iii/iv) → Tasks 8–9; the unverified host behavior (live-check §5 Q1) → Task 10, operator-gated. Config stays inside `tinystrap.toml` (§7 hard requirement) — only the `[host]` table shape is specified; CLI wiring deferred and named.
- **Placeholders:** none — every code block is complete and compiles against the signatures in *Interfaces consumed*; the one `as never` stub in Task 2's engine test is deliberate (the denial path returns before the ledger/evasion are consulted — `engine.ts` checks evasion only when effects are non-empty and the out-of-workspace denial precedes it; if the compiler complains, construct real `new ScriptLedger()` / `new EvasionTracker()` instead).
- **Type consistency:** `WireTool` defined once in `dialect.ts` and reused by `types.ts` (Task 3), `seed.ts`, `wire.ts`; `HostDialect` is the only new cross-package type; `ProxyDeps` gains exactly two optional fields across the whole plan (`dialect` in B, `phaseAllowlists` in C); `ProxyFeatures` gains exactly one (`interruption_feedback` in D). Gate and server keep their existing exported signatures — all changes are optional-parameter or additive-field changes, so identity-dialect callers are source-compatible.
- **Deviation from the orchestrator recommendation:** none structural. Two refinements, justified inline: (1) the dialect lives in `policy` (not `core`) because every consumer of normalization is policy-facing and `policy`'s purity rule (§6) is exactly the constraint a dialect must satisfy (Architecture); (2) disposition enforcement lives at two points — gate trip (Task 4) *and* omission from the forwarded array (Task 7) — because denying at preflight only while still offering the tool contradicts spec §9.6 and wastes small-model turns.
