# Small-Model Layer Completion Implementation Plan (spec §12 finish)

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Finish the small-model layer (spec §12) beyond what the tier-1 bench plan's Task 3 covers: give `edit_assistance`, `guidance`, and `pinned_notes` a real server-side mechanism so they move out of `UNIMPLEMENTED_FEATURES` and become ablatable; make model-profile-driven phase thinking (`chat_template_kwargs: { enable_thinking }`, spike-verified per-request on llama.cpp) actually reach the upstream request; expose the existing `NoteStore` as a callable harness tool; and land the edit-assistance matching/denial/syntax-check machinery.

**Architecture:** No new packages. Group A extends `packages/proxy/src/profiles.ts` (capability-aware selection) and wires phase thinking into `server.ts`. Group B adds a `pin_note` tool definition + harness-state effect classification in `@tinystrap/policy` (`harness.ts`) and a proxy module (`notetool.ts`) that executes pinned-note calls and re-injects the pinned block into outgoing requests. Group C adds pure string machinery in `@tinystrap/policy` (`editassist.ts`), enriches read-before-edit denials with a file slice, turns the currently **consumer-less** `PolicyDecision` `"rewrite"` variant into a working normalized-match correction applied by the `StreamGate`, and adds a fast post-edit syntax check to `@tinystrap/core` (`syntax.ts`). Group D adds per-task guidance state (plan checklist, tool cards, stall detector with the nudge → forced replan → stop ladder) in `packages/proxy/src/guidance.ts`, wired into `server.ts`. All server-side wiring is additive at the same points the bench plan's Task 3 established (`feats` switches, `taskId` from deps).

**Tech Stack:** Node.js 20+ (built-ins only — `node:vm` for the JS syntax check, `python` subprocess for the Python one, same pattern as `core/pythonast.ts`), TypeScript 5 strict ESM (NodeNext), pnpm workspaces, vitest. Same toolchain as the prior plans.

**Spec:** `docs/superpowers/specs/2026-09-20-tinystrap-harness-design.md` (§7 `[small_model]` switches, §12.1 profiles, §12.4 edit assistance, §12.5 guidance, §12.6 reasoning control, §12.7 pinned notes, §13.4 events, Appendix A8). Prior plans: proxy (`2026-09-21-proxy-and-small-model-layer.md`, landed), host layer (`2026-09-22-host-runner-and-opencode-adapter.md`), tier-1 bench (`2026-09-22-bench-tier1.md`, merged, **not yet executed**).

## Global Constraints

Copied from the spec (and the task brief); these bind every task:

- **Hard dependency: the tier-1 bench plan's Task 3 must land before any task in this plan.** This plan EXTENDS the `ProxyFeatures` table, `DEFAULT_FEATURES`, `UNIMPLEMENTED_FEATURES`, and the extended `ProxyDeps` (`features?`, `taskId?`, `budgetTokens?`) that bench Task 3 creates in `packages/proxy/src/features.ts` and `server.ts` — it does not redefine them. If bench Task 3 has already been executed when a worker starts, read the real `features.ts`/`server.ts` and adapt the additive edits to what is actually there.
- **Honesty rule (bench plan §Global Constraints, extended):** a feature name moves out of `UNIMPLEMENTED_FEATURES` only in the task that wires its real server-side mechanism: `pinned_notes` in Task 4 [Group B], `edit_assistance` in Task 7 [Group C], `guidance` in Task 11 [Group D]. Each of those tasks also updates `packages/proxy/test/features.test.ts` (which asserts the exact unimplemented list) in the same commit.
- Profiles are **data**, user-overridable; weaker models get simplified tool sets; unknown models get a conservative default (spec §12.1).
- Phase-based thinking: reasoning **on for planning/failure diagnosis, off or short for mechanical steps**; per-request off uses `chat_template_kwargs: {"enable_thinking": <bool>}` (spike-verified, Appendix A8 — **per-request only**; mid-stream forced close remains untested and is NOT introduced here) (spec §12.6).
- Pinned notes: **capped**, persist across turns, survive compaction, re-injected after compaction and at resume (spec §12.7). The cap forces brevity; the tool must not bypass `NoteStore`'s existing limits.
- Edit assistance (spec §12.4): a read-before-edit denial **includes the relevant file slice**; a failed exact-match edit tries **normalized (whitespace/line-ending insensitive) matching**, applies a fuzzy match **only if unambiguous**, otherwise returns the **closest lines**; after a successful edit a **fast syntax/lint check** shows only the **first error** — not a full verification pass.
- Guidance (spec §12.5): a **required short plan checklist** tracked by the harness; **per-turn tool cards** (count set by profile); **stall detection** (repeated identical calls, re-reading the same file, reverted edits) with the escalation ladder **nudge → forced replan → stop**.
- **No network in automated tests.** `FakeProvider` / hand-built `StreamChunk[]` fixtures only, same as the proxy and bench plans. The only subprocess a test may spawn is `python` for the Python syntax check (allowed command; no network).
- **No IP addresses, hostnames, usernames, or local paths anywhere** in code, tests, or docs (public repo; use `127.0.0.1` and placeholder paths like `/w`, `/l`, `/models/...` only as they already appear in fixtures).
- The proxy's existing behavior when **all features default on** must not regress: existing proxy/policy/core tests stay green unchanged; all `server.ts`, `features.ts`, `gate.ts`, `audit.ts`, and barrel (`index.ts`) edits are additive one-point changes, never rewrites.
- **Shared-file rule for parallel execution:** `packages/proxy/src/server.ts`, `packages/proxy/src/features.ts`, `packages/proxy/test/features.test.ts`, `packages/proxy/src/index.ts`, and `packages/policy/src/index.ts` are the ONLY files more than one group may touch, and only with the additive edits specified below. Every other file belongs to exactly one group. Workers must rebase on `main` before opening their PR.
- Coordination: `packages/policy/src/audit.ts` is also edited by the host plan's Task 1 (`tool_executed` etc.) and the bench plan's Task 4 (`model_usage`); this plan's Group D appends two more kinds to the same union — all additive, rebase before pushing. If bench Task 10 (ablation) is executed **after** this plan lands, its test that expects `pinned_notes` to be an unimplemented ablation target must use a still-unimplemented name instead (by the end of this plan the list is empty; the throw path itself stays).
- Explicitly deferred out of scope: mid-stream forced reasoning-close (proxy plan Task 14, Appendix A8); a real file-edit **executor** (none exists on `main` — see Spec-vs-code gaps; Group C is scoped to what is buildable against strings/fixtures and a callable syntax check); knowledge snippets and checkpoint-and-retry (spec §12.8); supervisor CLI wiring.
- Shell commands in this plan use **only** the allowed set: `git`, `python`, `python -m pytest`, `pytest`, `ruff`, `pnpm`, `npm`, `mkdir`, `ao`, `node`, `tinystrap`, `refdes`. **Never** `rm`, `npx`, `cd`, `for`-loops, or inline-assignment prefixes (`VAR=value cmd`) — refused by the shell whitelist; use `git -C <path>` instead of `cd`.
- Strict TDD, DRY, YAGNI, one commit per task minimum; every commit message ends with the line `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.

## Execution grouping

For the orchestrator to split work across workers/PRs. All four groups are safe to execute **in parallel** — no file overlap except the shared additive wiring points listed under Global Constraints (expect trivial one-line merge resolutions in `features.ts` / `features.test.ts` / `server.ts` / the two barrel files).

| Group | One-liner | Size | Tasks |
| ----- | --------- | ---- | ----- |
| **A** | Capability-gated profile selection + per-phase `enable_thinking` wiring into the upstream request (spec 12.1 + 12.6 phase part) | small | 2 |
| **B** | `pin_note` as a real callable harness tool: definition + harness-state effect classification (policy) + proxy execution and pinned-block re-injection (spec 12.7) | small | 2 |
| **C** | Edit assistance: normalized matching / closest-lines / denial slices in policy, gate applies `rewrite` decisions, fast post-edit syntax check in core (spec 12.4) | large | 4 |
| **D** | Guidance: plan checklist + per-turn tool cards + stall detector with nudge → replan → stop ladder, per-task state in the proxy (spec 12.5) | medium-large | 3 |

Cross-group ordering constraints (everything else is fully parallel):
- Every task depends on **bench-tier1 Task 3** having landed (the `feats`/`ProxyDeps` extension).
- Task 11 [Group D] reads `ModelProfile.toolCardLimit`, added by Task 1 [Group A]. If D runs first, land A's Task 1 first or have D's Task 11 use the `?? 3` fallback with a follow-up once A lands.
- Task 4 [Group B] emits `tool_executed` events, a kind added by the **host plan's Task 1** (trivial union extension; sequence after it).

## File Structure

| Path | Group | Responsibility (single) |
| ---- | ----- | ----------------------- |
| `packages/proxy/src/profiles.ts` | A | (modify) `toolCardLimit?` field, `supportsThinkingToggle`, `thinkingForRequest` |
| `packages/proxy/test/profiles.test.ts` | A | (extend) capability + toolCardLimit tests |
| `packages/proxy/test/server-thinking.test.ts` | A | request-shape tests for the thinking wiring |
| `packages/policy/src/harness.ts` | B | `PIN_NOTE_TOOL_NAME`, `PIN_NOTE_TOOL`, `effectsForHarnessTool` |
| `packages/policy/test/harness.test.ts` | B | tool definition + effect classification tests |
| `packages/proxy/src/notetool.ts` | B | `applyPinNote`, `withPinnedNotes` (re-injection) |
| `packages/proxy/test/notetool.test.ts` | B | store application + injection tests |
| `packages/proxy/test/server-notes.test.ts` | B | end-to-end pin_note call + re-injection through the server |
| `packages/policy/src/editassist.ts` | C | pure: `sliceAround`, `findNormalizedMatches`, `extractSpan`, `closestLines` |
| `packages/policy/test/editassist.test.ts` | C | pure-function tests |
| `packages/policy/src/guards.ts` | C | (modify) denial-with-slice support |
| `packages/policy/src/engine.ts` | C | (modify) `PolicyContext.readFile?`, `editAssistance?`; denial slice + normalized rewrite/closest-lines deny |
| `packages/policy/test/engine.test.ts` | C | (extend) edit-assistance engine tests |
| `packages/proxy/src/gate.ts` | C | (modify) apply `rewrite` decisions from preflight |
| `packages/proxy/test/gate.test.ts` | C | (extend) rewrite-application test |
| `packages/core/src/syntax.ts` | C | `checkEditSyntax` (fast, first error only) |
| `packages/core/test/syntax.test.ts` | C | syntax-check tests (js via `node:vm`, py via `python` subprocess) |
| `packages/proxy/src/guidance.ts` | D | `parsePlanItems`, `toolCards`, `GuidanceState`, stall ladder, `injectGuidance` |
| `packages/proxy/test/guidance.test.ts` | D | guidance unit tests |
| `packages/proxy/test/server-guidance.test.ts` | D | server wiring tests (plan capture, cards, stall escalation) |
| `packages/policy/src/audit.ts` | D | (modify, additive) `guidance_updated`, `stall_escalated` kinds |
| `packages/proxy/src/server.ts` | A+B+C+D | **shared** — one additive wiring point per group (see tasks) |
| `packages/proxy/src/features.ts` | B+C+D | **shared** — one-line removals from `UNIMPLEMENTED_FEATURES` |
| `packages/proxy/test/features.test.ts` | B+C+D | **shared** — matching assertion updates |
| `packages/proxy/src/index.ts`, `packages/policy/src/index.ts`, `packages/core/src/index.ts` | owners | **shared barrels** — one additive export line each (B: harness/notetool, C: editassist/syntax, D: guidance) |

## Interfaces consumed (verified against the code on `main`, 2026-09-22)

```ts
// @tinystrap/policy (packages/policy/src)
export function evaluate(req: ToolRequest, ctx: PolicyContext): PolicyDecision;
// types.ts:
export type PolicyDecision =
  | { effect: "allow" }
  | { effect: "ask"; reason: string }
  | { effect: "deny"; reason: string; correction?: string; retryable: boolean }
  | { effect: "rewrite"; args: unknown; reason: string };   // ← zero consumers on main (gap 1)
export type ToolDefinition = {
  name: string; description: string; inputSchema: JsonSchema;
  capabilities: string[]; readOnly: boolean;
};
export type EffectRecord = {
  target: string; kind: "read" | "write" | "delete" | "exec" | "network" | "git" | "secret";
  scope: "in_workspace" | "out_of_workspace";
};
export type Phase = "planning" | "implementation" | "verification" | "promotion";
// engine.ts:
export type PolicyContext = {
  workspaceRoot: string; registry: ToolRegistry;
  phaseAllowlists?: Partial<Record<Phase, readonly string[]>>;
  readSet: ReadonlySet<string>;
  exists: (normalizedPath: string) => boolean;
  realPaths: ReadonlyMap<string, string>;
  ledger: ScriptLedger; evasion: EvasionTracker; pythonAst?: unknown;
};
// guards.ts:
export function checkReadBeforeEdit(path: string, readSet: ReadonlySet<string>): PolicyDecision;
// registry.ts:
export function createToolRegistry(): ToolRegistry; // { register(def), lookup(name), all() }
// audit.ts:
export function makeEvent(taskId: string, kind: HarnessEventKind, fields?: Partial<Omit<HarnessEvent, "taskId" | "kind" | "timestamp">>): HarnessEvent;

// @tinystrap/proxy (packages/proxy/src)
export type ChatRequest = { model: string; messages: ChatMessage[]; tools?: ToolDefinition[];
  tool_choice?: "auto" | "required" | "none"; stream?: boolean;
  chat_template_kwargs?: Record<string, unknown> };   // ← field already exists on main
export type ChatMessage = { role: ChatRole; content: string | null;
  tool_calls?: ToolCall[]; tool_call_id?: string };
export type ToolCall = { id: string; type: "function";
  function: { name: string; arguments: string } };
export class StreamGate {
  constructor(opts: { registry: ToolRegistry; preflight: Preflight });
  push(chunk: StreamChunk): GateAction;
  accumulated(): ToolCall[];
}
export type Preflight = (tool: string, args: Record<string, unknown>) => PolicyDecision;
export class NoteStore {
  constructor(opts?: { cap?: number; maxChars?: number });   // cap 5, maxChars 200
  set(key: string, note: string): void;    // throws over cap / over maxChars
  remove(key: string): void;
  renderPinned(): string;                  // "" when empty; block starts "--- pinned notes (harness) ---"
}
export type ModelProfile = {
  id: string; match: RegExp; toolAllowlist?: readonly string[];
  thinking: { planning: boolean; mechanical: boolean };
  repairStrictness: "strict" | "lenient" | "off"; budgetReserveTokens: number;
};
export function selectProfile(modelId: string, profiles?: readonly ModelProfile[]): ModelProfile;
export function thinkingKwargs(profile: ModelProfile, phase: Phase):
  { chat_template_kwargs: { enable_thinking: boolean } };
export function formatSse(chunk: StreamChunk): string;
export const SSE_DONE = "data: [DONE]\n\n";
export function parseSseRecords(raw: string): StreamChunk[];
export function interruptionChunks(req: ChatRequest, reason: string): StreamChunk[];
export const HARNESS_NOTICE_TOOL = "harness_notice";
export class FakeProvider implements Provider { constructor(streams: RecordedStream[]); }
export type RecordedStream = { server: string; attempt: string; status: number;
  chunks: StreamChunk[]; summary: Record<string, unknown> };
export async function startProxy(deps: ProxyDeps, port = 0):
  Promise<{ url: string; close(): Promise<void> }>;
// ProxyDeps after bench Task 3 = { provider, registry, preflight, onEvent?,
//   features?, taskId?, budgetTokens? }

// @tinystrap/discovery (packages/discovery/src/llamacpp.ts)
export type LlamaCppFacts = { modelAlias: string; nCtx: number; buildInfo: string;
  totalSlots: number; chatTemplateCaps: Record<string, boolean> };
export class LlamaCppDiscovery { lastFacts(): LlamaCppFacts | null; /* probe() */ }
// recorded caps keys (spike fixture): supports_tool_calls, supports_tools,
// supports_parallel_tool_calls, supports_object_arguments, supports_preserve_reasoning,
// supports_reasoning_effort, supports_string_content, supports_system_role, supports_typed_content
// — there is NO dedicated enable_thinking caps key (gap 6).

// @tinystrap/core (packages/core/src/pythonast.ts)
export function parsePythonAst(source: string): Promise<unknown | null>;
```

## Spec-vs-code gaps found while writing this plan (report upstream)

1. **`PolicyDecision` `"rewrite"` has zero consumers** (verified: only `types.ts` mentions it). Group C Task 7 gives it one: the gate applies rewritten args before flushing.
2. **No file-edit executor exists anywhere on `main`** — policy only checks *hypothetical* edits (`engine.ts` classifies `req.args.path`; nothing applies `oldText`/`newText`), and core only extracts git patches. Group C is therefore scoped to string/fixture-testable mechanisms plus a callable `checkEditSyntax` for the future executor/host layer; no fake executor is invented.
3. **`thinkingKwargs` and `NoteStore` are dead code on `main`** — implemented by the proxy plan, never called by `server.ts`. This plan wires both.
4. **`chat_template_caps` has no key for the `enable_thinking` toggle.** Gating on `caps.supports_tools === true` (a llama.cpp template that accepts `chat_template_kwargs` at all) is a **heuristic** — mark to verify alongside Appendix A8.
5. **README "Model adapters" wording verified accurate** on `main` (`6f82ec5`): "Model adapters (host integrations for OpenCode and pi — thin plugins that point the host's model base URL at the tinystrap proxy)". Per the brief ("only touch it if actually wrong") **no README task is included**.
6. **`harness_notice` is not registered in `createToolRegistry()`** — server tests register it manually. Group B's pin_note rewrite reuses the same synthetic channel and the same caller-registration convention; a default registration is a supervisor-plan decision, not silently taken here.

---

### Task 1 [Group A]: Capability-aware profile selection + `toolCardLimit`

**Files:**
- Modify: `packages/proxy/src/profiles.ts`
- Test: `packages/proxy/test/profiles.test.ts` (extend the existing file)

**Interfaces:**
- Consumes: `ModelProfile`, `selectProfile`, `thinkingKwargs`, `Phase` (verified above).
- Produces (exported from `@tinystrap/proxy`):

```ts
// ModelProfile gains one optional field (all existing entries updated in-file):
//   toolCardLimit?: number;   // guidance tool-card count per spec 12.5; qwen3: 2, default: 3
export function supportsThinkingToggle(caps: Record<string, boolean> | null | undefined): boolean;
export function thinkingForRequest(
  modelId: string,
  caps: Record<string, boolean> | null,
  phase: Phase,
  profiles?: readonly ModelProfile[],
): { chat_template_kwargs?: { enable_thinking: boolean } };  // {} when the toggle is unsupported
```

Steps:

- [ ] Extend `packages/proxy/test/profiles.test.ts`:

```ts
import { supportsThinkingToggle, thinkingForRequest, BUILTIN_PROFILES, DEFAULT_PROFILE } from "@tinystrap/proxy";

describe("capability-gated thinking (spec 12.1/12.6)", () => {
  const caps = { supports_tools: true, supports_tool_calls: true };
  it("supportsThinkingToggle requires a caps object with supports_tools", () => {
    expect(supportsThinkingToggle(caps)).toBe(true);
    expect(supportsThinkingToggle({})).toBe(false);
    expect(supportsThinkingToggle(null)).toBe(false);
    expect(supportsThinkingToggle(undefined)).toBe(false);
  });
  it("thinkingForRequest emits per-phase kwargs when supported", () => {
    expect(thinkingForRequest("qwen3-x", caps, "planning"))
      .toEqual({ chat_template_kwargs: { enable_thinking: true } });
    expect(thinkingForRequest("qwen3-x", caps, "implementation"))
      .toEqual({ chat_template_kwargs: { enable_thinking: false } });
  });
  it("thinkingForRequest emits nothing when unsupported", () => {
    expect(thinkingForRequest("qwen3-x", null, "planning")).toEqual({});
  });
  it("profiles carry a toolCardLimit", () => {
    expect(DEFAULT_PROFILE.toolCardLimit).toBe(3);
    expect(BUILTIN_PROFILES.find((p) => p.id === "qwen3")!.toolCardLimit).toBe(2);
  });
});
```

- [ ] Run `pnpm test -- profiles`. Expected: FAIL — `supportsThinkingToggle`/`thinkingForRequest` not exported, `toolCardLimit` not on `ModelProfile`.
- [ ] Implement in `profiles.ts`: add `toolCardLimit?: number` to `ModelProfile`; set `toolCardLimit: 3` on `DEFAULT_PROFILE`, `toolCardLimit: 2` on the qwen3 entry; append:

```ts
// Heuristic (gap 4): no dedicated enable_thinking caps key exists on llama.cpp;
// a template advertising tool support accepts chat_template_kwargs (spike A8). To verify.
export function supportsThinkingToggle(caps: Record<string, boolean> | null | undefined): boolean {
  return !!caps && caps.supports_tools === true;
}

export function thinkingForRequest(
  modelId: string, caps: Record<string, boolean> | null, phase: Phase,
  profiles: readonly ModelProfile[] = BUILTIN_PROFILES,
): { chat_template_kwargs?: { enable_thinking: boolean } } {
  if (!supportsThinkingToggle(caps)) return {};
  return thinkingKwargs(selectProfile(modelId, profiles), phase);
}
```

- [ ] Run `pnpm test` + `pnpm typecheck`. Expected: PASS.
- [ ] Commit:

```bash
git add packages/proxy/src/profiles.ts packages/proxy/test/profiles.test.ts
git commit -m "feat(proxy): capability-gated profile thinking and toolCardLimit

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2 [Group A]: Wire per-phase thinking into the upstream request

**Files:**
- Modify: `packages/proxy/src/server.ts` (additive wiring point — do not restructure)
- Test: `packages/proxy/test/server-thinking.test.ts`

**Interfaces:**
- Consumes: `thinkingForRequest` (Task 1); `ProxyDeps` with bench Task 3's `features`/`taskId`; `ChatRequest.chat_template_kwargs` (already on `types.ts`).
- Produces: `ProxyDeps` gains (additive):

```ts
serverCaps?: Record<string, boolean> | null;   // LlamaCppDiscovery.lastFacts()?.chatTemplateCaps ?? null
phase?: () => Phase;                           // current task phase; default () => "planning"
```

Wiring (inside `handle`, after `chatReq` is parsed and before `provider.stream`, behind `feats.reasoning_control`):

```ts
if (feats.reasoning_control) {
  const kw = thinkingForRequest(chatReq.model, deps.serverCaps ?? null, deps.phase?.() ?? "planning");
  if (kw.chat_template_kwargs) {
    chatReq = { ...chatReq,
      chat_template_kwargs: { ...kw.chat_template_kwargs, ...(chatReq.chat_template_kwargs ?? {}) } };
  }
}
```

Caller-set kwargs always win (config precedence, spec §7).

Steps:

- [ ] Write `packages/proxy/test/server-thinking.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createToolRegistry } from "@tinystrap/policy";
import { FakeProvider, startProxy } from "@tinystrap/proxy";
import type { ChatRequest, Provider, StreamChunk } from "@tinystrap/proxy";

class SpyProvider implements Provider {
  seen: ChatRequest[] = [];
  constructor(private readonly inner: Provider) {}
  async *stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamChunk> {
    this.seen.push(req);
    yield* this.inner.stream(req, signal);
  }
}

const quiet: StreamChunk[] = [
  { choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
];
const caps = { supports_tools: true };

async function post(proxyUrl: string, body: Record<string, unknown>): Promise<void> {
  await fetch(`${proxyUrl}/v1/chat/completions`, { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "qwen3-test", stream: true,
      messages: [{ role: "user", content: "hi" }], ...body }) });
}

describe("phase thinking wiring", () => {
  it("mechanical phase sends enable_thinking false", async () => {
    const spy = new SpyProvider(new FakeProvider(
      [{ server: "s", attempt: "a", status: 200, chunks: quiet, summary: {} }]));
    const proxy = await startProxy({ provider: spy, registry: createToolRegistry(),
      preflight: () => ({ effect: "allow" }), serverCaps: caps, phase: () => "implementation" });
    await post(proxy.url, {});
    await proxy.close();
    expect(spy.seen[0].chat_template_kwargs).toEqual({ enable_thinking: false });
  });
  it("planning phase sends enable_thinking true", async () => {
    const spy = new SpyProvider(new FakeProvider(
      [{ server: "s", attempt: "a", status: 200, chunks: quiet, summary: {} }]));
    const proxy = await startProxy({ provider: spy, registry: createToolRegistry(),
      preflight: () => ({ effect: "allow" }), serverCaps: caps, phase: () => "planning" });
    await post(proxy.url, {});
    await proxy.close();
    expect(spy.seen[0].chat_template_kwargs).toEqual({ enable_thinking: true });
  });
  it("no caps means no kwargs injected; caller kwargs survive", async () => {
    const spy = new SpyProvider(new FakeProvider(
      [{ server: "s", attempt: "a", status: 200, chunks: quiet, summary: {} }]));
    const proxy = await startProxy({ provider: spy, registry: createToolRegistry(),
      preflight: () => ({ effect: "allow" }), serverCaps: null, phase: () => "implementation" });
    await post(proxy.url, { chat_template_kwargs: { enable_thinking: true } });
    await proxy.close();
    expect(spy.seen[0].chat_template_kwargs).toEqual({ enable_thinking: true });
  });
});
```

- [ ] Run `pnpm test -- server-thinking`. Expected: FAIL — TS errors on `serverCaps`/`phase` in `ProxyDeps`, then behavior failures.
- [ ] Implement the `ProxyDeps` fields and the wiring block above in `server.ts`. Add `import type { Phase } from "@tinystrap/policy";` and extend the existing proxy import with `thinkingForRequest`.
- [ ] Run `pnpm test` + `pnpm typecheck`. Expected: PASS — existing server tests send models like `"m"` with `serverCaps` unset, so no kwargs are injected and streams are unchanged.
- [ ] Commit:

```bash
git add packages/proxy/src/server.ts packages/proxy/test/server-thinking.test.ts
git commit -m "feat(proxy): send per-phase enable_thinking kwargs upstream behind reasoning_control

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3 [Group B]: `pin_note` tool definition + harness-state effect classification

**Files:**
- Create: `packages/policy/src/harness.ts`
- Modify: `packages/policy/src/index.ts` (one export line)
- Test: `packages/policy/test/harness.test.ts`

**Interfaces:**
- Consumes: `ToolDefinition`, `EffectRecord` from `./types.js` (verified above).
- Produces (exported from `@tinystrap/policy`):

```ts
export const PIN_NOTE_TOOL_NAME = "pin_note";
export const PIN_NOTE_TOOL: ToolDefinition;      // name "pin_note", readOnly false,
                                                 // capabilities ["harness_state_write"]
export function effectsForHarnessTool(tool: string): EffectRecord[];
// pin_note → [{ target: "harness:notes", kind: "write", scope: "in_workspace" }]
// — a workspace-scoped write to HARNESS state, never a filesystem effect (spec 12.7).
```

`evaluate()` deliberately stays untouched: `pin_note` is not in `FILE_TOOLS`, so a registered `pin_note` passes the engine (subject to phase allowlists) with no filesystem effects; the harness effect is classified here and consumed by the proxy in Task 4 for audit.

Steps:

- [ ] Write `packages/policy/test/harness.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { PIN_NOTE_TOOL, PIN_NOTE_TOOL_NAME, effectsForHarnessTool, createToolRegistry } from "@tinystrap/policy";

describe("pin_note harness tool", () => {
  it("is a valid non-read-only tool definition", () => {
    expect(PIN_NOTE_TOOL.name).toBe(PIN_NOTE_TOOL_NAME);
    expect(PIN_NOTE_TOOL.readOnly).toBe(false);
    expect(PIN_NOTE_TOOL.capabilities).toEqual(["harness_state_write"]);
    expect(PIN_NOTE_TOOL.inputSchema.required).toEqual(["key"]);
    const r = createToolRegistry();
    r.register(PIN_NOTE_TOOL);
    expect(r.lookup("pin_note")).toBe(PIN_NOTE_TOOL);
  });
  it("classifies as a harness-state write, not a filesystem write", () => {
    expect(effectsForHarnessTool("pin_note")).toEqual(
      [{ target: "harness:notes", kind: "write", scope: "in_workspace" }]);
    expect(effectsForHarnessTool("write")).toEqual([]);
  });
});
```

- [ ] Run `pnpm test -- harness`. Expected: FAIL — module not exported.
- [ ] Create `packages/policy/src/harness.ts`:

```ts
import type { EffectRecord, ToolDefinition } from "./types.js";

export const PIN_NOTE_TOOL_NAME = "pin_note";

export const PIN_NOTE_TOOL: ToolDefinition = {
  name: PIN_NOTE_TOOL_NAME,
  description: "Pin a short decision, current plan item, or confirmed fact. " +
    "Max 5 notes, 200 chars each. {key, note} to set; {key, remove: true} to remove.",
  inputSchema: {
    type: "object",
    properties: {
      key: { type: "string" },
      note: { type: "string" },
      remove: { type: "boolean" },
    },
    required: ["key"],
  },
  capabilities: ["harness_state_write"],
  readOnly: false,
};

// Harness-state effect: never a filesystem target (spec 12.7). Used for audit
// effectSignature by the proxy when it executes the call.
export function effectsForHarnessTool(tool: string): EffectRecord[] {
  if (tool !== PIN_NOTE_TOOL_NAME) return [];
  return [{ target: "harness:notes", kind: "write", scope: "in_workspace" }];
}
```

- [ ] Add `export * from "./harness.js";` to `packages/policy/src/index.ts`. Run `pnpm test` + `pnpm typecheck`. Expected: PASS.
- [ ] Commit:

```bash
git add packages/policy/src/harness.ts packages/policy/src/index.ts packages/policy/test/harness.test.ts
git commit -m "feat(policy): pin_note tool definition and harness-state effect classification

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4 [Group B]: Proxy execution of `pin_note` + pinned-block re-injection

**Files:**
- Create: `packages/proxy/src/notetool.ts`
- Modify: `packages/proxy/src/server.ts` (additive wiring point), `packages/proxy/src/index.ts`, `packages/proxy/src/features.ts` (remove `"pinned_notes"` from `UNIMPLEMENTED_FEATURES`), `packages/proxy/test/features.test.ts` (matching assertion)
- Test: `packages/proxy/test/notetool.test.ts`, `packages/proxy/test/server-notes.test.ts`

**Interfaces:**
- Consumes: `NoteStore` (verified), `PIN_NOTE_TOOL`/`PIN_NOTE_TOOL_NAME`/`effectsForHarnessTool` (Task 3), `interruptionChunks`, `formatSse`, `SSE_DONE` (verified), `makeEvent(taskId, "tool_executed", …)` (host plan Task 1), `feats` (bench Task 3).
- Produces (exported from `@tinystrap/proxy`):

```ts
export const PINNED_SENTINEL = "--- pinned notes (harness) ---";   // matches NoteStore.renderPinned()
export type PinOutcome = { applied: boolean; message: string };
export function applyPinNote(store: NoteStore, args: Record<string, unknown>): PinOutcome;
export function withPinnedNotes(messages: ChatMessage[], pinned: string): ChatMessage[];
```

Server wiring (two additive points, both behind `feats.pinned_notes`):
1. Before the stream loop: `if (!deps.registry.lookup(PIN_NOTE_TOOL_NAME)) deps.registry.register(PIN_NOTE_TOOL);` and `chatReq = { ...chatReq, messages: withPinnedNotes(chatReq.messages, notes.renderPinned()) };` where `const notes = new NoteStore();` lives in the `startProxy` closure (one proxy per task — same lifetime assumption as bench Task 3's `taskId`).
2. At the existing flush point (`if (choice?.finish_reason) flushPending();`): inspect `gate.accumulated()`; for every `pin_note` call, `applyPinNote(notes, parsedArgs)` and emit `makeEvent(taskId, "tool_executed", { tool: "pin_note", reason: out.message, effectSignature: effectSignature(effectsForHarnessTool("pin_note")) })`. If **all** accumulated calls are `pin_note`, suppress the raw flush and instead write `interruptionChunks(chatReq, "pin_note: " + lastMessage).map(formatSse).join("")` + `SSE_DONE`, then end the response — the host sees a well-formed synthetic turn instead of a call to a tool it does not implement. **Known v1 limitation (document in code):** mixed `pin_note` + other-tool calls apply and log the notes but forward the raw stream unchanged; full tool-result plumbing is a supervisor-plan item.

Steps:

- [ ] Write `packages/proxy/test/notetool.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { NoteStore, applyPinNote, withPinnedNotes, PINNED_SENTINEL } from "@tinystrap/proxy";
import type { ChatMessage } from "@tinystrap/proxy";

describe("applyPinNote", () => {
  it("sets, overwrites, and removes through the capped store", () => {
    const s = new NoteStore({ cap: 1, maxChars: 10 });
    expect(applyPinNote(s, { key: "plan", note: "do x" })).toEqual({ applied: true, message: "pinned plan" });
    expect(applyPinNote(s, { key: "other", note: "nope" }).applied).toBe(false); // cap
    expect(applyPinNote(s, { key: "plan", remove: true })).toEqual({ applied: true, message: "unpinned plan" });
    expect(applyPinNote(s, { note: "no key" }).applied).toBe(false);
    expect(applyPinNote(s, { key: "k" }).applied).toBe(false); // no note, no remove
  });
});

describe("withPinnedNotes", () => {
  const msgs: ChatMessage[] = [
    { role: "system", content: "you are a coder" },
    { role: "user", content: "hi" },
  ];
  it("inserts the pinned block after the leading system message", () => {
    const out = withPinnedNotes(msgs, `${PINNED_SENTINEL}\nplan: do x\n--- end pinned notes ---`);
    expect(out).toHaveLength(3);
    expect(out[1].role).toBe("system");
    expect(out[1].content).toContain("plan: do x");
  });
  it("replaces rather than duplicates an existing pinned block", () => {
    const once = withPinnedNotes(msgs, `${PINNED_SENTINEL}\nplan: a\n--- end pinned notes ---`);
    const twice = withPinnedNotes(once, `${PINNED_SENTINEL}\nplan: b\n--- end pinned notes ---`);
    expect(twice.filter((m) => m.content?.startsWith(PINNED_SENTINEL))).toHaveLength(1);
    expect(twice[1].content).toContain("plan: b");
  });
  it("empty pinned text strips any existing block", () => {
    const once = withPinnedNotes(msgs, `${PINNED_SENTINEL}\nplan: a\n--- end pinned notes ---`);
    expect(withPinnedNotes(once, "")).toEqual(msgs);
  });
});
```

- [ ] Write `packages/proxy/test/server-notes.test.ts` — a stream whose single tool call is `pin_note`:

```ts
import { describe, expect, it } from "vitest";
import { createToolRegistry } from "@tinystrap/policy";
import { FakeProvider, HARNESS_NOTICE_TOOL, parseSseRecords, startProxy } from "@tinystrap/proxy";
import type { HarnessEvent } from "@tinystrap/policy";
import type { ChatMessage, ChatRequest, Provider, RecordedStream, StreamChunk } from "@tinystrap/proxy";

function pinStream(name = "pin_note"): RecordedStream[] {
  const chunks: StreamChunk[] = [
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1",
      function: { name, arguments: '{"key":"plan","note":"ship v1"}' } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ];
  return [{ server: "s", attempt: "a", status: 200, chunks, summary: {} }];
}

async function post(url: string, body: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${url}/v1/chat/completions`, { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m", stream: true,
      messages: [{ role: "user", content: "hi" }], ...body }) });
  return res.text();
}

describe("pin_note through the server", () => {
  it("executes the note call, emits tool_executed, rewrites to harness_notice", async () => {
    const events: HarnessEvent[] = [];
    const proxy = await startProxy({
      provider: new FakeProvider(pinStream()), registry: createToolRegistry(),
      preflight: () => ({ effect: "allow" }), onEvent: (e) => events.push(e),
    });
    const text = await post(proxy.url, {});
    await proxy.close();
    expect(events.some((e) => e.kind === "tool_executed" && e.tool === "pin_note")).toBe(true);
    const out = parseSseRecords(text);
    const names = out.flatMap((c) => c.choices[0]?.delta.tool_calls ?? [])
      .map((d) => d.function?.name);
    expect(names).toEqual([HARNESS_NOTICE_TOOL]); // raw pin_note never reaches the host
  });
  it("re-injects the pinned block into the next request on the same instance", async () => {
    const seen: ChatMessage[][] = [];
    const inner = new FakeProvider([...pinStream(), ...pinStream()]); // pin runs on both requests
    const spy: Provider = {
      async *stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamChunk> {
        seen.push(req.messages);
        yield* inner.stream(req, signal);
      },
    };
    const proxy = await startProxy({ provider: spy, registry: createToolRegistry(),
      preflight: () => ({ effect: "allow" }) });
    await post(proxy.url, {});
    await post(proxy.url, {});
    await proxy.close();
    const pinned = (msgs: ChatMessage[]) => msgs.filter((m) =>
      m.role === "system" && m.content?.startsWith("--- pinned notes")).length;
    expect(pinned(seen[0])).toBe(0);  // store empty on the first request
    expect(pinned(seen[1])).toBe(1);  // first call pinned "plan" → re-injected (spec 12.7)
    expect(seen[1].find((m) => m.content?.startsWith("--- pinned notes"))!.content)
      .toContain("plan: ship v1");
  });
});
```

Imports for this file: `ChatMessage`, `ChatRequest`, `Provider`, `RecordedStream` (types) from `@tinystrap/proxy`; `StreamChunk` from `@tinystrap/proxy`. Persistence **across** proxy instances (task resume) is supervisor state (spec 12.7), out of scope here — the store lives per `startProxy`, the same lifetime assumption as bench Task 3's `taskId`.

- [ ] Run `pnpm test -- notetool server-notes`. Expected: FAIL — not exported / no wiring.
- [ ] Implement `notetool.ts`:

```ts
import { NoteStore } from "./notes.js";
import type { ChatMessage } from "./types.js";

export const PINNED_SENTINEL = "--- pinned notes (harness) ---";
export type PinOutcome = { applied: boolean; message: string };

export function applyPinNote(store: NoteStore, args: Record<string, unknown>): PinOutcome {
  const key = typeof args.key === "string" ? args.key : "";
  if (key === "") return { applied: false, message: "pin_note: missing key" };
  try {
    if (args.remove === true) { store.remove(key); return { applied: true, message: `unpinned ${key}` }; }
    if (typeof args.note !== "string") return { applied: false, message: "pin_note: note must be a string" };
    store.set(key, args.note);
    return { applied: true, message: `pinned ${key}` };
  } catch (err) {
    return { applied: false, message: `pin_note rejected: ${(err as Error).message}` };
  }
}

export function withPinnedNotes(messages: ChatMessage[], pinned: string): ChatMessage[] {
  const kept = messages.filter((m) =>
    !(m.role === "system" && typeof m.content === "string" && m.content.startsWith(PINNED_SENTINEL)));
  if (pinned === "") return kept;
  const at = kept.length > 0 && kept[0].role === "system" ? 1 : 0;
  return [...kept.slice(0, at), { role: "system" as const, content: pinned }, ...kept.slice(at)];
}
```

- [ ] Wire `server.ts` as specified above (register-if-absent, re-inject before `provider.stream`, intercept at the flush point; import `NoteStore`, `applyPinNote`, `withPinnedNotes`, `PIN_NOTE_TOOL`, `PIN_NOTE_TOOL_NAME`, `effectsForHarnessTool`, `effectSignature`, `interruptionChunks`). Remove `"pinned_notes"` from `UNIMPLEMENTED_FEATURES` in `features.ts` and update the `features.test.ts` assertion to the remaining two names. Add `export * from "./notetool.js";` to the proxy `index.ts`.
- [ ] Run `pnpm test` + `pnpm typecheck`. Expected: PASS (existing server tests register their own registries; `pin_note` registration-if-absent is invisible to them; their streams contain no `pin_note` calls).
- [ ] Commit:

```bash
git add packages/proxy/src/notetool.ts packages/proxy/src/server.ts packages/proxy/src/features.ts packages/proxy/src/index.ts packages/proxy/test/notetool.test.ts packages/proxy/test/server-notes.test.ts packages/proxy/test/features.test.ts
git commit -m "feat(proxy): execute pin_note calls and re-inject pinned notes (spec 12.7)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5 [Group C]: Pure edit-assistance string machinery

**Files:**
- Create: `packages/policy/src/editassist.ts`
- Modify: `packages/policy/src/index.ts` (one export line)
- Test: `packages/policy/test/editassist.test.ts`

**Interfaces:**
- Consumes: nothing outside `@tinystrap/policy` built-ins.
- Produces (exported from `@tinystrap/policy`):

```ts
export type LineSpan = { startLine: number; endLine: number };   // 0-based, inclusive
export function sliceAround(content: string, line: number, radius: number):
  { startLine: number; endLine: number; text: string };
export function findNormalizedMatches(content: string, oldText: string): LineSpan[];
  // whitespace-insensitive line-sequence match; blank lines ignored on both sides
export function extractSpan(content: string, span: LineSpan): string;
export function closestLines(content: string, oldText: string, max?: number):
  { line: number; text: string }[];   // token-overlap ranking, default max 5
```

Steps:

- [ ] Write `packages/policy/test/editassist.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { sliceAround, findNormalizedMatches, extractSpan, closestLines } from "@tinystrap/policy";

const FILE = [
  "function add(a, b) {",
  "  return a+b;",
  "}",
  "",
  "const x = 1;",
].join("\n");

describe("editassist", () => {
  it("sliceAround clamps to file bounds", () => {
    const s = sliceAround(FILE, 0, 1);
    expect(s).toEqual({ startLine: 0, endLine: 1,
      text: "function add(a, b) {\n  return a+b;" });
  });
  it("finds a whitespace-normalized match and extracts the ORIGINAL text", () => {
    const spans = findNormalizedMatches(FILE, "return  a + b");
    expect(spans).toEqual([{ startLine: 1, endLine: 1 }]);
    expect(extractSpan(FILE, spans[0])).toBe("  return a+b;");
  });
  it("reports every match for ambiguous oldText", () => {
    const dup = "a\nb\na\nb";
    expect(findNormalizedMatches(dup, "a\nb")).toEqual(
      [{ startLine: 0, endLine: 1 }, { startLine: 2, endLine: 3 }]);
  });
  it("no match returns empty; closestLines ranks by overlap", () => {
    expect(findNormalizedMatches(FILE, "nothing here at all")).toEqual([]);
    const near = closestLines(FILE, "  return a + b; extra", 2);
    expect(near[0].line).toBe(1);
  });
});
```

- [ ] Run `pnpm test -- editassist`. Expected: FAIL — not exported.
- [ ] Implement `editassist.ts`:

```ts
export type LineSpan = { startLine: number; endLine: number };

function normLine(s: string): string { return s.replace(/\s+/g, " ").trim(); }

export function sliceAround(content: string, line: number, radius: number):
  { startLine: number; endLine: number; text: string } {
  const lines = content.split(/\r?\n/);
  const startLine = Math.max(0, line - radius);
  const endLine = Math.min(lines.length - 1, line + radius);
  return { startLine, endLine, text: lines.slice(startLine, endLine + 1).join("\n") };
}

export function findNormalizedMatches(content: string, oldText: string): LineSpan[] {
  const norm = content.split(/\r?\n/).map(normLine);
  const want = oldText.split(/\r?\n/).map(normLine).filter((l) => l !== "");
  if (want.length === 0) return [];
  const idx: number[] = [];
  norm.forEach((l, i) => { if (l !== "") idx.push(i); });
  const spans: LineSpan[] = [];
  for (let s = 0; s + want.length <= idx.length; s++) {
    let ok = true;
    for (let k = 0; k < want.length; k++) {
      if (norm[idx[s + k]] !== want[k]) { ok = false; break; }
    }
    if (ok) spans.push({ startLine: idx[s], endLine: idx[s + want.length - 1] });
  }
  return spans;
}

export function extractSpan(content: string, span: LineSpan): string {
  return content.split(/\r?\n/).slice(span.startLine, span.endLine + 1).join("\n");
}

export function closestLines(content: string, oldText: string, max = 5):
  { line: number; text: string }[] {
  const target = new Set(normLine(oldText.split(/\r?\n/)[0] ?? "").split(" ").filter(Boolean));
  if (target.size === 0) return [];
  return content.split(/\r?\n/)
    .map((text, line) => {
      const toks = normLine(text).split(" ").filter(Boolean);
      const score = toks.length === 0 ? 0
        : toks.filter((t) => target.has(t)).length / toks.length;
      return { line, text, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map(({ line, text }) => ({ line, text }));
}
```

- [ ] Add `export * from "./editassist.js";` to `packages/policy/src/index.ts`. Run `pnpm test` + `pnpm typecheck`. Expected: PASS.
- [ ] Commit:

```bash
git add packages/policy/src/editassist.ts packages/policy/src/index.ts packages/policy/test/editassist.test.ts
git commit -m "feat(policy): pure edit-assistance matching primitives (spec 12.4)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6 [Group C]: Read-before-edit denial includes the relevant file slice

**Files:**
- Modify: `packages/policy/src/engine.ts` (additive: `PolicyContext.readFile?`, denial enrichment), `packages/policy/src/guards.ts` (additive optional param)
- Test: `packages/policy/test/engine.test.ts` (extend), `packages/policy/test/guards.test.ts` (extend)

**Interfaces:**
- Consumes: `checkReadBeforeEdit` (verified), `sliceAround` (Task 5).
- Produces: `PolicyContext` gains `readFile?: (normalizedPath: string) => string | null;` (additive optional — existing callers unaffected); `checkReadBeforeEdit(path, readSet, slice?: { startLine: number; text: string }): PolicyDecision` (third param optional; when present the correction embeds `Current content (from line <startLine+1>):\n<text>`).

Steps:

- [ ] Extend `packages/policy/test/guards.test.ts`:

```ts
import { checkReadBeforeEdit } from "@tinystrap/policy";

it("embeds a file slice in the correction when one is provided", () => {
  const d = checkReadBeforeEdit("a.ts", new Set(), { startLine: 3, text: "const x = 1;\nconst y = 2;" });
  expect(d.effect).toBe("deny");
  expect(d.effect === "deny" && d.correction).toContain("Current content (from line 4):");
  expect(d.effect === "deny" && d.correction).toContain("const y = 2;");
});
```

- [ ] Extend `packages/policy/test/engine.test.ts` — build the existing test `PolicyContext` shape (already in the file) plus `readFile: () => "l0\nl1\nl2\nl3\nl4\nl5"` and assert an `edit` request for an unread path yields a `deny` whose `correction` contains `"Current content (from line 1):"` and `"l2"`.
- [ ] Run `pnpm test -- guards engine`. Expected: FAIL — signature/context mismatch (TS) then behavior.
- [ ] Implement: in `guards.ts`, add the optional third parameter and append the slice block to the correction string when provided. In `engine.ts`, add `readFile?: (normalizedPath: string) => string | null;` to `PolicyContext` and replace the read-before-edit branch with:

```ts
if ((req.tool === "edit" || req.tool === "apply_patch") && !ctx.readSet.has(target)) {
  const decision = checkReadBeforeEdit(target, ctx.readSet);
  if (decision.effect === "deny" && decision.correction && ctx.readFile) {
    const content = ctx.readFile(target);
    if (content !== null) {
      const slice = sliceAround(content, 0, 20);
      return { ...decision,
        correction: `${decision.correction}\nCurrent content (from line ${slice.startLine + 1}):\n${slice.text}` };
    }
  }
  return decision;
}
```

- [ ] Run `pnpm test` + `pnpm typecheck`. Expected: PASS — `readFile` unset in every existing context ⇒ byte-identical denials.
- [ ] Commit:

```bash
git add packages/policy/src/guards.ts packages/policy/src/engine.ts packages/policy/test/guards.test.ts packages/policy/test/engine.test.ts
git commit -m "feat(policy): read-before-edit denials carry a file slice (spec 12.4)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7 [Group C]: Normalized-match rewrite + closest-lines denial; the gate applies `rewrite`

**Files:**
- Modify: `packages/policy/src/engine.ts` (edit-assistance branch), `packages/proxy/src/gate.ts` (apply rewrite), `packages/proxy/src/features.ts` (remove `"edit_assistance"` from `UNIMPLEMENTED_FEATURES`), `packages/proxy/test/features.test.ts` (assertion)
- Test: `packages/policy/test/engine.test.ts` (extend), `packages/proxy/test/gate.test.ts` (extend)

**Interfaces:**
- Consumes: `findNormalizedMatches`, `extractSpan`, `closestLines` (Task 5); `PolicyContext.readFile` (Task 6); `PolicyDecision` `"rewrite"` variant (verified, consumer-less today); `StreamGate.check` (verified).
- Produces: `PolicyContext` gains `editAssistance?: boolean` (default true when `undefined`); gate behavior: a preflight `"rewrite"` decision replaces the buffered arguments (`part.args = JSON.stringify(d.args)`) and the call continues as allowed — **first consumer of the rewrite variant** (gap 1).

Engine branch (inside the `FILE_TOOLS` block, after the read-before-edit check passes, behind `ctx.editAssistance !== false`):

```ts
if (req.tool === "edit" && ctx.readFile) {
  const oldText = typeof req.args.oldText === "string" ? req.args.oldText : null;
  const content = ctx.readFile(target);
  if (oldText !== null && content !== null && !content.includes(oldText)) {
    const spans = findNormalizedMatches(content, oldText);
    if (spans.length === 1) {
      return { effect: "rewrite",
        args: { ...req.args, oldText: extractSpan(content, spans[0]) },
        reason: "edit_assistance: whitespace-normalized match applied" };
    }
    if (spans.length > 1) {
      return deny("edit_denied: oldText matches several places (whitespace-insensitive).",
        `Add more context lines. Matches start at lines: ${spans.map((s) => s.startLine + 1).join(", ")}.`, true);
    }
    const near = closestLines(content, oldText);
    return deny("edit_denied: oldText not found in the file.",
      `Closest lines:\n${near.map((c) => `${c.line + 1}: ${c.text}`).join("\n")}`, true);
  }
}
```

Steps:

- [ ] Extend `packages/policy/test/engine.test.ts` (same context-construction helpers as Task 6):
  - exact-match oldText → `{ effect: "allow" }` (unchanged path);
  - whitespace-drifted oldText, one match → `effect === "rewrite"` and `(d as { args: { oldText: string } }).args.oldText` equals the original file lines;
  - two matches → deny with `"several places"` and line numbers in the correction;
  - no match → deny with `"Closest lines:"` in the correction;
  - `editAssistance: false` + drifted oldText → plain `{ effect: "allow" }` (switch respected).
- [ ] Extend `packages/proxy/test/gate.test.ts`:

```ts
it("applies a rewrite decision to the buffered arguments", () => {
  const gate = gateForTest({ effect: "rewrite", args: { path: "a.ts", oldText: "fixed" },
    reason: "edit_assistance" });
  const chunks = [
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1",
      function: { name: "edit", arguments: '{"path":"a.ts","oldText":"broken"}' } }] },
      finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ];
  for (const c of chunks) expect(gate.push(c).kind).toBe("forward");
  expect(JSON.parse(gate.accumulated()[0].function.arguments).oldText).toBe("fixed");
});
```

- [ ] Run `pnpm test -- engine gate`. Expected: FAIL.
- [ ] Implement the engine branch (imports from `./editassist.js`) and the gate change in `check()`:

```ts
const d = this.opts.preflight(part.name, parsed);
if (d.effect === "rewrite") { part.args = JSON.stringify(d.args); return undefined; }
if (d.effect === "deny" || d.effect === "ask") return this.trip(d.reason, part.name);
return undefined;
```

Remove `"edit_assistance"` from `UNIMPLEMENTED_FEATURES` in `features.ts`; update the `features.test.ts` assertion to the remaining one name (`"guidance"`).
- [ ] Run `pnpm test` + `pnpm typecheck`. Expected: PASS — existing gate tests use constant allow/deny preflights; the rewrite branch is unreachable for them.
- [ ] Commit:

```bash
git add packages/policy/src/engine.ts packages/policy/test/engine.test.ts packages/proxy/src/gate.ts packages/proxy/test/gate.test.ts packages/proxy/src/features.ts packages/proxy/test/features.test.ts
git commit -m "feat(policy,proxy): normalized edit matching via rewrite decisions (spec 12.4)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8 [Group C]: Fast post-edit syntax check (first error only)

**Files:**
- Create: `packages/core/src/syntax.ts`
- Modify: `packages/core/src/index.ts` (one export line)
- Test: `packages/core/test/syntax.test.ts`

**Interfaces:**
- Consumes: nothing outside `node:vm`, `node:child_process`, `node:path`.
- Produces (exported from `@tinystrap/core`):

```ts
export type SyntaxCheck = { ok: true } | { ok: false; error: string };
export function checkEditSyntax(filePath: string, content: string): Promise<SyntaxCheck>;
// .py  → python ast.parse subprocess; first non-blank stderr line as `error`
// .js / .cjs → node:vm compile (no execution); SyntaxError message first line
// .mjs / .ts / everything else → { ok: true } (no fast parser; honest YAGNI note in code)
```

Integration note (record in the file header comment): **no edit executor exists on `main`** (gap 2). This function is the seam the future executor / host runner calls after applying an edit, surfacing only the first error (spec 12.4 — not a full verification pass). This task wires nothing.

Steps:

- [ ] Write `packages/core/test/syntax.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { checkEditSyntax } from "@tinystrap/core";

describe("checkEditSyntax", () => {
  it("accepts valid javascript", async () => {
    expect(await checkEditSyntax("a.js", "const x = 1;\n")).toEqual({ ok: true });
  });
  it("reports the first javascript syntax error", async () => {
    const r = await checkEditSyntax("a.js", "function f( {\n");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.split("\n")[0].length).toBeGreaterThan(0);
  });
  it("accepts valid python", async () => {
    expect(await checkEditSyntax("m.py", "def f():\n    return 1\n")).toEqual({ ok: true });
  });
  it("reports the first python syntax error", async () => {
    const r = await checkEditSyntax("m.py", "def f(:\n");
    expect(r.ok).toBe(false);
  });
  it("skips unsupported extensions", async () => {
    expect(await checkEditSyntax("x.ts", "this is not code at all {{{")).toEqual({ ok: true });
  });
});
```

- [ ] Run `pnpm test -- syntax`. Expected: FAIL — not exported.
- [ ] Implement `syntax.ts`:

```ts
import { execFile } from "node:child_process";
import { extname } from "node:path";
import vm from "node:vm";

export type SyntaxCheck = { ok: true } | { ok: false; error: string };

export function checkEditSyntax(filePath: string, content: string): Promise<SyntaxCheck> {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".py") return checkPython(content);
  if (ext === ".js" || ext === ".cjs") return Promise.resolve(checkJs(content));
  return Promise.resolve({ ok: true }); // .mjs/.ts: no fast built-in parser (YAGNI)
}

function checkJs(content: string): SyntaxCheck {
  try { new vm.Script(content); return { ok: true }; }
  catch (err) { return { ok: false, error: (err as Error).message.split("\n")[0] }; }
}

function checkPython(content: string): Promise<SyntaxCheck> {
  return new Promise((resolve) => {
    const child = execFile("python",
      ["-c", "import ast,sys; ast.parse(sys.stdin.read())"],
      (err, _out, stderr) => {
        if (!err) { resolve({ ok: true }); return; }
        const first = (stderr || "").split(/\r?\n/).find((l) => l.trim() !== "") ?? "syntax error";
        resolve({ ok: false, error: first.trim() });
      });
    child.stdin?.write(content);
    child.stdin?.end();
  });
}
```

- [ ] Add `export * from "./syntax.js";` to `packages/core/src/index.ts`. Run `pnpm test` + `pnpm typecheck`. Expected: PASS (python subprocess tests need `python` on PATH — already required by the bench plan's python tasks).
- [ ] Commit:

```bash
git add packages/core/src/syntax.ts packages/core/src/index.ts packages/core/test/syntax.test.ts
git commit -m "feat(core): fast post-edit syntax check seam (spec 12.4)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 9 [Group D]: Guidance state — plan checklist, tool cards, injection helper

**Files:**
- Create: `packages/proxy/src/guidance.ts`
- Test: `packages/proxy/test/guidance.test.ts`

**Interfaces:**
- Consumes: `ChatMessage` (proxy types), `ToolDefinition` (policy).
- Produces (exported from `@tinystrap/proxy`):

```ts
export const GUIDANCE_SENTINEL = "--- harness guidance ---";
export function parsePlanItems(text: string): string[];        // markdown checklist lines, max 5
export function toolCards(tools: ToolDefinition[], limit: number): string[];
export function injectGuidance(messages: ChatMessage[], blocks: string[]): ChatMessage[];
export class GuidanceState {
  constructor(opts: { taskId: string; toolCardLimit: number });
  hasPlan(): boolean;
  requirePlan(): string;                       // directive text, spec 12.5 "required"
  submitPlan(items: string[]): void;           // first plan wins; capped at 5 items
  planItems(): readonly string[];
}
```

Steps:

- [ ] Write `packages/proxy/test/guidance.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parsePlanItems, toolCards, injectGuidance, GuidanceState, GUIDANCE_SENTINEL } from "@tinystrap/proxy";
import type { ChatMessage, ToolDefinition } from "@tinystrap/proxy";

const tools: ToolDefinition[] = ["read", "edit", "bash", "grep"].map((n) => ({
  name: n, description: `the ${n} tool`, inputSchema: {}, capabilities: [], readOnly: n === "read" }));

describe("guidance", () => {
  it("parses checklist items and caps at five", () => {
    const items = parsePlanItems("intro\n- [ ] one\n- [x] two\n- [ ] three\n- [ ] four\n- [ ] five\n- [ ] six");
    expect(items).toEqual(["one", "two", "three", "four", "five"]);
    expect(parsePlanItems("no checklist here")).toEqual([]);
  });
  it("toolCards respects the profile limit", () => {
    expect(toolCards(tools, 2)).toEqual(["read: the read tool (read-only)", "edit: the edit tool"]);
  });
  it("injectGuidance replaces, never duplicates, and strips when empty", () => {
    const msgs: ChatMessage[] = [{ role: "system", content: "base" }, { role: "user", content: "go" }];
    const once = injectGuidance(msgs, [`${GUIDANCE_SENTINEL}\nplan please`]);
    const twice = injectGuidance(once, [`${GUIDANCE_SENTINEL}\nnew text`]);
    expect(twice.filter((m) => m.content?.startsWith(GUIDANCE_SENTINEL))).toHaveLength(1);
    expect(twice[1].content).toContain("new text");
    expect(injectGuidance(once, [])).toEqual(msgs);
  });
  it("first submitted plan wins", () => {
    const g = new GuidanceState({ taskId: "t", toolCardLimit: 3 });
    expect(g.hasPlan()).toBe(false);
    g.submitPlan(["a", "b"]);
    g.submitPlan(["c"]);
    expect(g.planItems()).toEqual(["a", "b"]);
    expect(g.requirePlan()).toContain("plan");
  });
});
```

- [ ] Run `pnpm test -- guidance`. Expected: FAIL — not exported.
- [ ] Implement `guidance.ts`:

```ts
import type { ToolDefinition } from "@tinystrap/policy";
import type { ChatMessage } from "./types.js";

export const GUIDANCE_SENTINEL = "--- harness guidance ---";

export function parsePlanItems(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*[-*]\s+\[[ xX]?\]\s+(.+)$/.exec(line);
    if (m) out.push(m[1].trim());
    if (out.length === 5) break;
  }
  return out;
}

export function toolCards(tools: ToolDefinition[], limit: number): string[] {
  return tools.slice(0, limit).map((t) =>
    `${t.name}: ${t.description}${t.readOnly ? " (read-only)" : ""}`);
}

export function injectGuidance(messages: ChatMessage[], blocks: string[]): ChatMessage[] {
  const kept = messages.filter((m) =>
    !(m.role === "system" && typeof m.content === "string" && m.content.startsWith(GUIDANCE_SENTINEL)));
  if (blocks.length === 0) return kept;
  const at = kept.length > 0 && kept[0].role === "system" ? 1 : 0;
  const block = `${GUIDANCE_SENTINEL}\n${blocks.join("\n")}\n--- end guidance ---`;
  return [...kept.slice(0, at), { role: "system" as const, content: block }, ...kept.slice(at)];
}

export class GuidanceState {
  private plan: string[] = [];

  constructor(private readonly opts: { taskId: string; toolCardLimit: number }) {}

  hasPlan(): boolean { return this.plan.length > 0; }
  requirePlan(): string {
    return "Start your reply with a short plan: up to 5 markdown checklist items (- [ ] ...).";
  }
  submitPlan(items: string[]): void {
    if (this.plan.length === 0 && items.length > 0) this.plan = items.slice(0, 5);
  }
  planItems(): readonly string[] { return this.plan; }
  get toolCardLimit(): number { return this.opts.toolCardLimit; }
}
```

- [ ] Add `export * from "./guidance.js";` to the proxy `index.ts`. Run `pnpm test` + `pnpm typecheck`. Expected: PASS.
- [ ] Commit:

```bash
git add packages/proxy/src/guidance.ts packages/proxy/src/index.ts packages/proxy/test/guidance.test.ts
git commit -m "feat(proxy): guidance state — required plan checklist and tool cards (spec 12.5)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 10 [Group D]: Stall detection and the escalation ladder

**Files:**
- Modify: `packages/proxy/src/guidance.ts` (add stall members)
- Test: `packages/proxy/test/guidance.test.ts` (extend)

**Interfaces:**
- Consumes: `ToolCall` (proxy types, verified).
- Produces (exported from `@tinystrap/proxy`):

```ts
export type StallLevel = "none" | "nudge" | "replan" | "stop";
export const STALL_NUDGE = "Harness: you appear stuck (repeated identical actions). State what changed and take a different concrete step.";
export const STALL_REPLAN = "Harness: repeated stalling. Discard the current approach, write a new short plan, and take one different action.";
// GuidanceState gains:
//   recordCalls(calls: ToolCall[]): boolean;   // true when any stall signal tripped this batch
//     // signals: identical name+arguments call ≥ 3×; same read path ≥ 4×; an edit whose
//     // newText equals the previously recorded newText for that path (revert)
//   escalate(): StallLevel;                    // per stall hit: 1→nudge, 2→replan, ≥3→stop
//   stallCount(): number;
```

Steps:

- [ ] Extend `packages/proxy/test/guidance.test.ts`:

```ts
import { GuidanceState, STALL_NUDGE, STALL_REPLAN } from "@tinystrap/proxy";
import type { ToolCall } from "@tinystrap/proxy";

function call(name: string, args: string): ToolCall {
  return { id: "c", type: "function", function: { name, arguments: args } };
}

describe("stall detection", () => {
  it("detects the third identical call", () => {
    const g = new GuidanceState({ taskId: "t", toolCardLimit: 3 });
    expect(g.recordCalls([call("read", '{"path":"a.ts"}')])).toBe(false);
    expect(g.recordCalls([call("read", '{"path":"a.ts"}')])).toBe(false);
    expect(g.recordCalls([call("read", '{"path":"a.ts"}')])).toBe(true);
  });
  it("detects a reverted edit", () => {
    const g = new GuidanceState({ taskId: "t", toolCardLimit: 3 });
    g.recordCalls([call("edit", '{"path":"a.ts","oldText":"1","newText":"2"}')]);
    g.recordCalls([call("edit", '{"path":"a.ts","oldText":"2","newText":"3"}')]);
    expect(g.recordCalls([call("edit", '{"path":"a.ts","oldText":"3","newText":"2"}')])).toBe(true);
  });
  it("escalates nudge → replan → stop", () => {
    const g = new GuidanceState({ taskId: "t", toolCardLimit: 3 });
    expect(g.escalate()).toBe("nudge");
    expect(g.escalate()).toBe("replan");
    expect(g.escalate()).toBe("stop");
    expect(STALL_NUDGE.length).toBeGreaterThan(10);
    expect(STALL_REPLAN.length).toBeGreaterThan(10);
  });
});
```

- [ ] Run `pnpm test -- guidance`. Expected: FAIL — members missing.
- [ ] Implement in `guidance.ts`:

```ts
export type StallLevel = "none" | "nudge" | "replan" | "stop";
export const STALL_NUDGE = "Harness: you appear stuck (repeated identical actions). State what changed and take a different concrete step.";
export const STALL_REPLAN = "Harness: repeated stalling. Discard the current approach, write a new short plan, and take one different action.";

// inside GuidanceState:
private callCounts = new Map<string, number>();
private readCounts = new Map<string, number>();
private lastNewText = new Map<string, string>();
private stalls = 0;

recordCalls(calls: ToolCall[]): boolean {
  let stalled = false;
  for (const c of calls) {
    const n = (this.callCounts.get(`${c.function.name}:${c.function.arguments}`) ?? 0) + 1;
    this.callCounts.set(`${c.function.name}:${c.function.arguments}`, n);
    if (n >= 3) stalled = true;
    if (c.function.name === "read") {
      try {
        const p = String((JSON.parse(c.function.arguments) as { path?: string }).path ?? "");
        if (p !== "") {
          const r = (this.readCounts.get(p) ?? 0) + 1;
          this.readCounts.set(p, r);
          if (r >= 4) stalled = true;
        }
      } catch { /* unparseable args: identical-call signal already covers it */ }
    }
    if (c.function.name === "edit") {
      try {
        const a = JSON.parse(c.function.arguments) as { path?: string; newText?: string };
        if (typeof a.path === "string" && typeof a.newText === "string") {
          if (this.lastNewText.has(a.path) && this.lastNewText.get(a.path) === a.newText) stalled = true;
          this.lastNewText.set(a.path, a.newText);
        }
      } catch { /* as above */ }
    }
  }
  return stalled;
}

escalate(): StallLevel {
  this.stalls += 1;
  if (this.stalls === 1) return "nudge";
  if (this.stalls === 2) return "replan";
  return "stop";
}

stallCount(): number { return this.stalls; }
```

- [ ] Run `pnpm test` + `pnpm typecheck`. Expected: PASS.
- [ ] Commit:

```bash
git add packages/proxy/src/guidance.ts packages/proxy/test/guidance.test.ts
git commit -m "feat(proxy): stall detection with nudge/replan/stop ladder (spec 12.5)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 11 [Group D]: Wire guidance into the server + audit kinds

**Files:**
- Modify: `packages/policy/src/audit.ts` (additive union extension), `packages/proxy/src/server.ts` (additive wiring point), `packages/proxy/src/features.ts` (remove `"guidance"` from `UNIMPLEMENTED_FEATURES` — the list becomes `[]`), `packages/proxy/test/features.test.ts` (assertion)
- Test: `packages/proxy/test/server-guidance.test.ts`

**Interfaces:**
- Consumes: `GuidanceState`, `parsePlanItems`, `toolCards`, `injectGuidance`, `STALL_NUDGE`, `STALL_REPLAN` (Tasks 9–10); `selectProfile` (existing) for `toolCardLimit` (Task 1's optional field; use `?? 3` fallback if A has not landed); `interruptionSse` (verified); `makeEvent` (verified).
- Produces: `HarnessEventKind` additionally includes `"guidance_updated" | "stall_escalated"` (append to the union — same file is also extended by host plan Task 1 and bench Task 4; additive, rebase before pushing).

Server wiring (one additive block, behind `feats.guidance`; `const guidance = new GuidanceState({ taskId, toolCardLimit: selectProfile(chatReq.model).toolCardLimit ?? 3 })` created per `startProxy` alongside the notes store):
1. Before `provider.stream`: `chatReq = { ...chatReq, messages: injectGuidance(chatReq.messages, blocks) }` where `blocks` = `[guidance.requirePlan()]` when `!guidance.hasPlan()`, plus `[guidance tool cards]` = `toolCards(deps.registry.all(), guidance.toolCardLimit)` joined under a `tool cards:` header.
2. Accumulate assistant text: `let assistantText = "";` … `assistantText += choice?.delta.content ?? "";` in the chunk loop. After the loop (before `SSE_DONE`): `const items = parsePlanItems(assistantText); if (items.length > 0 && !guidance.hasPlan()) { guidance.submitPlan(items); deps.onEvent?.(makeEvent(taskId, "guidance_updated", { reason: \`plan:${items.length}\` })); }`
3. At the flush point: `if (guidance.recordCalls(gate.accumulated())) { const level = guidance.escalate(); deps.onEvent?.(makeEvent(taskId, "stall_escalated", { reason: `${level}:${guidance.stallCount()}` })); if (level === "stop") { ac.abort(); res.write(interruptionSse(chatReq, "guidance: stall stop")); res.end(); return; } const nudge = level === "nudge" ? STALL_NUDGE : STALL_REPLAN; res.write(formatSse({ choices: [{ index: 0, delta: { content: nudge }, finish_reason: null }] })); }` (no new `HarnessEvent` fields; the audit model gains only the two kinds).

Steps:

- [ ] Write `packages/proxy/test/server-guidance.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createToolRegistry } from "@tinystrap/policy";
import { FakeProvider, HARNESS_NOTICE_TOOL, parseSseRecords, startProxy } from "@tinystrap/proxy";
import type { HarnessEvent } from "@tinystrap/policy";
import type { StreamChunk } from "@tinystrap/proxy";

function callStream(n: number): StreamChunk[] {
  const one: StreamChunk =
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c",
      function: { name: "read", arguments: '{"path":"a.ts"}' } }] }, finish_reason: null }] };
  const done: StreamChunk = { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] };
  const out: StreamChunk[] = [];
  for (let i = 0; i < n; i++) out.push(one, done);
  return out;
}

async function post(url: string): Promise<string> {
  const res = await fetch(`${url}/v1/chat/completions`, { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] }) });
  return res.text();
}

function registry() {
  const r = createToolRegistry();
  r.register({ name: "read", description: "read a file", inputSchema: {}, capabilities: [], readOnly: true });
  r.register({ name: HARNESS_NOTICE_TOOL, description: "no-op", inputSchema: {}, capabilities: [], readOnly: true });
  return r;
}

describe("guidance wiring", () => {
  it("stall detection escalates and emits stall_escalated events", async () => {
    const events: HarnessEvent[] = [];
    const proxy = await startProxy({
      provider: new FakeProvider([{ server: "s", attempt: "a", status: 200,
        chunks: callStream(3), summary: {} }]),
      registry: registry(), preflight: () => ({ effect: "allow" }),
      onEvent: (e) => events.push(e),
    });
    const text = await post(proxy.url);
    await proxy.close();
    const stalls = events.filter((e) => e.kind === "stall_escalated");
    expect(stalls.map((e) => e.reason)).toEqual(["nudge:1", "replan:2", "stop:3"]);
    const out = parseSseRecords(text);
    const content = out.map((c) => c.choices[0]?.delta.content ?? "").join("");
    expect(content).toContain("stuck");          // nudge reached the client
    expect(out.some((c) => (c.choices[0]?.delta.tool_calls ?? []).length > 0
      && c.choices[0]!.delta.tool_calls![0].function?.name === HARNESS_NOTICE_TOOL)).toBe(true);
  });
  it("guidance off: no events, raw stream untouched", async () => {
    const events: HarnessEvent[] = [];
    const proxy = await startProxy({
      provider: new FakeProvider([{ server: "s", attempt: "a", status: 200,
        chunks: callStream(3), summary: {} }]),
      registry: registry(), preflight: () => ({ effect: "allow" }),
      onEvent: (e) => events.push(e),
      features: { guidance: false },
    });
    await post(proxy.url);
    await proxy.close();
    expect(events.filter((e) => e.kind === "stall_escalated" || e.kind === "guidance_updated")).toEqual([]);
  });
});
```

- [ ] Run `pnpm test -- server-guidance`. Expected: FAIL — kinds missing / no wiring.
- [ ] Append the two kinds to `HarnessEventKind` in `audit.ts`; implement the server wiring exactly as specified; remove `"guidance"` from `UNIMPLEMENTED_FEATURES` (list becomes `[]`) and update `features.test.ts` (the "every name appears in one of the two lists" compile-level check stays and now proves full implementation coverage).
- [ ] Run `pnpm test` (whole repo) + `pnpm typecheck`. Expected: PASS — existing server tests use single tool-call streams (below the 3× stall threshold) and content-free deltas.
- [ ] Commit:

```bash
git add packages/policy/src/audit.ts packages/proxy/src/server.ts packages/proxy/src/features.ts packages/proxy/test/features.test.ts packages/proxy/test/server-guidance.test.ts
git commit -m "feat(proxy,policy): guidance wiring, stall escalation events, full feature coverage (spec 12.5)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Verification (whole plan)

- `pnpm test` — all packages green, **zero network** (FakeProvider / hand-built `StreamChunk[]` only; the sole subprocess is `python` in `syntax.test.ts`).
- `pnpm typecheck` — unchanged package list; no new packages.
- `UNIMPLEMENTED_FEATURES` is `[]` at the end; the bench ablation runner's honesty rule now covers all six `[small_model]` mechanisms (extending `TIER1_MATRIX` with the three new switches is a follow-up for the bench plan's owner, not this plan).
- Existing proxy/policy/core tests unchanged and green (all wiring additive; every switch defaults on and reproduces prior byte streams for the existing fixtures).

## Self-review record

- **Spec coverage:** §12.1 (Task 1), §12.4 (Tasks 5–8), §12.5 (Tasks 9–11), §12.6 phase-thinking (Tasks 1–2), §12.7 (Tasks 3–4). §12.2/§12.3/loop-detector wiring belong to bench-tier1 Task 3 (dependency, not duplicated). §12.8 stays deferred. README line verified accurate — no task (gap 5).
- **Placeholders:** none — every code block is complete and every run step states the expected failure/pass.
- **Type consistency:** `thinkingForRequest` (A) returns the same shape as `thinkingKwargs`; `LineSpan`/`extractSpan` used identically in Tasks 5–7; `PinOutcome`, `StallLevel`, `SyntaxCheck` each defined once and consumed by name; `PINNED_SENTINEL` matches `NoteStore.renderPinned()`'s existing first line; `planItems()` is the single plan accessor name (Task 9 defines, Task 11 consumes).
