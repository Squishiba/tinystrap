# tinystrap init Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Ship `tinystrap init` — a zero-input command that finds the operator's local model server, confirms the model / context length / profile, writes exactly one `tinystrap.toml`, runs `doctor`, runs a real tool-call smoke test through the production proxy, and prints (never applies) host setup instructions for OpenCode and pi. Non-interactive runs are possible via `--yes`, `--url`, `--model`, and `--dir`.

**Architecture:** Four packages, one seam each. **`packages/discovery`** grows a `LocalDiscovery` implementation of the existing `Discovery` interface that sweeps a fixed list of loopback targets, classifies each responder from its response bodies, and — new — reports a `ProbeAttempt[]` so a failed probe can explain itself. **`packages/core`** grows the config writer (`renderInitToml` + `writeInitConfig`, never clobbering without `--force`), a probe table in `doctor`, an injected-IO prompt module, and `runSmokeTest` — an HTTP client for a running proxy that asserts one tool call round-trips. **`apps/cli`** grows a flag parser, a `runInit` orchestrator, and host-instruction printing. The smoke test is the real seam between them: `runSmokeTest` speaks plain HTTP to `startProxy`, so its unit test runs the actual production proxy with a scripted `FakeProvider` behind it, and only an operator-run script ever points it at a real server. No new package, no new third-party dependency, no change to `startProxy` or `ProxyDeps`.

**Tech Stack:** TypeScript 5 strict ESM (NodeNext), pnpm workspaces, vitest. Node built-ins (`node:fs`, `node:path`, `node:os`) plus the existing `smol-toml` (already a direct `@tinystrap/core` dependency, locked at `1.8.0`) and the existing workspace packages. Tests use injected `fetch` doubles, `StubDiscovery`, an injected IO object, and `FakeProvider` — never a socket to anything but the loopback proxy the test itself starts. Same toolchain as the prior plans.

**Spec:** `docs/superpowers/specs/2026-09-20-tinystrap-harness-design.md` (§7 "One config file" and its precedence chain, §8 zero-input discovery table incl. the llama.cpp `/props` + `/v1/models` facts and the "to verify" Ollama / LM Studio rows, §8.1 `tinystrap doctor`, §12.1 model profiles, §12.3 context budgeting from discovered `n_ctx`, §14 error-handling table row "Server unreachable / model missing"). Triggering evidence: `docs/superpowers/spike-findings/opencode-live-check.md`. Prior plans: `2026-09-24-host-tool-dialects.md` (landed — `HostDialect`, `createOpenCodeDialect`, and the per-request registry seeding this plan's smoke test depends on), `2026-09-22-bench-tier1.md` (format reference).

## Global Constraints

- **No network in automated tests.** Only loopback `fetch` against a proxy the test itself started with `startProxy`, and injected `fetchImpl` doubles for discovery. No real model server, no host binary, no TTY, in any CI task. The live path is operator-run only (Task 12).
- **Public repository.** No IP addresses, hostnames, usernames, or local paths anywhere in code, tests, or docs. Use `127.0.0.1` (the one address this project always binds), `http://example.invalid`, and `mkdtempSync(join(tmpdir(), "ts-init-"))` — never a literal filesystem path. The operator's LAN address must never appear.
- **`tinystrap.toml` is the only config file this plan writes.** No user-defaults file is created, no `.tinystrap/` content beyond what already exists, and **host configs are never created or edited** — OpenCode and pi setup is printed as text and nothing more (Task 10).
- **Probing is loopback-or-operator-supplied.** `LocalDiscovery` probes a fixed loopback port list and nothing else. A non-loopback `--url` is reachable only because the operator typed it, and only after the flag parser has validated it as a URL (Task 9).
- **`smol-toml` is the TOML library, and no new dependency is added.** Justified in full under *Dependency choice* below; the writer's comment-preservation strategy follows from that library's actual behavior.
- **Never clobber.** `writeInitConfig` refuses to touch an existing `tinystrap.toml` unless `--force` is passed, and `--force` is the only path that overwrites. Idempotence is defined as "a second `init` without `--force` is a no-op that reports the existing file", not "writes the same bytes twice".
- **Prompt UI takes injected IO.** `PromptIO` is a plain object with `out` / `err` / `ask` / `isTty`. No `process.stdin`, no `readline`, no TTY in tests; `--yes` selects the top candidate without asking.
- **Dependency direction is unchanged.** `core` gains no runtime dependency on `proxy`. The one new import of `@tinystrap/proxy` from `core` is in a **test** file, satisfied by a `devDependency` (Task 8). `policy` and `discovery` are untouched by group C/D.
- **Existing behavior must not regress.** Every current core / discovery / CLI test stays green unchanged. `config.ts`, `doctor.ts`, `discovery/src/index.ts`, and `main.ts` get additive changes at named insertion points, never rewrites.
- **Shared-file rule for parallel execution:** `packages/core/src/index.ts` is the only multi-group file (one additive export line per task: B adds 2, C adds 3, D adds 1). `packages/discovery/src/index.ts` is **A only**. `apps/cli/src/main.ts` is **D only** (Task 11). `packages/core/src/doctor.ts` is **C only** (Task 6). Every other file has exactly one owning task. Workers rebase on `main` before pushing and merge in the order in *Execution grouping*.
- Explicitly deferred out of scope: Ollama / LM Studio live identification (spec §8 marks both "to verify" — this plan reports an ambiguous `/v1/models` responder as `openai-compatible`); resolving total-vs-per-slot `n_ctx` (Appendix A10); the `[workspace]` and `[host]` config tables from spec §7; writing a user-level defaults file; `tinystrap doctor`'s verify-command and sandbox-backend rows (spec §8.1, a later plan); a `pi` dialect (its tool argument names are unverified per spec §13.2).
- Shell commands in this plan use **only** the allowed set: `git`, `gh`, `python`, `pnpm`, `npm`, `mkdir`, `ao`, `node`, `tinystrap`, `refdes`. **Never** `rm`, `npx`, `cd`, `for`-loops, or inline-assignment prefixes (`VAR=value cmd`) — refused by the shell whitelist; use `git -C <path>` instead of `cd`.
- Strict TDD, DRY, YAGNI, one commit per task minimum; every commit message ends with the line `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.

## Execution grouping

For the orchestrator to split work across workers/PRs.

| Group | One-liner | Size | Tasks |
| ----- | --------- | ---- | ----- |
| **A** | `LocalDiscovery`: loopback port policy, per-attempt probe reporting, responder classification | medium | 3 |
| **B** | One-file config: comment-bearing TOML renderer + never-clobber writer | small | 2 |
| **C** | Verification surfaces: doctor's probe table + profile seam, injected-IO prompts, real-proxy smoke test | medium | 3 |
| **D** | CLI: flag parsing + exit codes, host instructions, `runInit` orchestration, operator live script | medium | 4 |

Dependencies and merge order (**A ∥ B first**, then C, then D):

```text
A (discovery) ─┐
               ├─► C (verification) ─► D (cli)      merge: A, B, C, D
B (config)   ──┘
```

- **A and B touch disjoint packages** (`packages/discovery` vs `packages/core`) and can run fully in parallel.
- **C needs A's types** (the doctor probe table in Task 6 renders `ProbeAttempt[]` from `DiscoveredValues`) and needs nothing from B. C's three tasks are three new files in `core` plus one additive change to `doctor.ts`, so its own tasks are sequential in one worker.
- **D needs all of A, B, and C** — `runInit` composes discovery, the writer, the prompts, the smoke test, and the instructions.
- `packages/core/src/index.ts` is the one file four tasks add to; merge **B before C before D** so each later worker rebases once and appends below the existing export lines.

## File Structure

| Path | Group | Responsibility (single) |
| ---- | ----- | ----------------------- |
| `packages/discovery/src/index.ts` | A | (modify, additive) `ProbeAttempt`, optional `attempts` / `probeSource` on `DiscoveredValues`, re-export `local.js` |
| `packages/discovery/src/local.ts` | A | `LOCAL_PORTS`, `isLoopbackUrl`, `localTargets`, `LocalDiscovery` |
| `packages/discovery/test/local.test.ts` | A | port policy, attempt reporting, classification, aggregate failure text |
| `packages/core/src/init-toml.ts` | B | `InitTomlValues`, `renderInitToml` (comment-bearing template) |
| `packages/core/src/init-write.ts` | B | `ConfigExistsError`, `writeInitConfig` (never clobber, `--force`) |
| `packages/core/test/init-toml.test.ts` | B | renderer round-trips through `parse`, comments present |
| `packages/core/test/init-write.test.ts` | B | clobber refusal, `--force`, idempotence, Windows-safe paths |
| `packages/core/src/doctor.ts` | C | (modify, additive) probe table + optional profile resolver seam |
| `packages/core/test/doctor-probe.test.ts` | C | probe table rows, "no server" explanation |
| `packages/core/src/prompt.ts` | C | `PromptIO`, `chooseServer`, `confirmModel`, `askContextOverride` |
| `packages/core/test/prompt.test.ts` | C | injected-IO prompts, `--yes` path, non-TTY fallback |
| `packages/core/src/smoke.ts` | C | `SmokeResult`, `runSmokeTest` (HTTP client for a running proxy) |
| `packages/core/test/smoke.test.ts` | C | real `startProxy` + scripted `FakeProvider`, pass and fail paths |
| `packages/core/package.json` | C | (modify, additive) `@tinystrap/proxy` as a **devDependency** |
| `apps/cli/src/flags.ts` | D | `InitFlags`, `ExitCode`, `parseInitFlags` |
| `apps/cli/test/flags.test.ts` | D | flag parsing, usage errors, exit-code mapping |
| `packages/core/src/instructions.ts` | D | `renderHostInstructions` (OpenCode + pi, print-only) |
| `packages/core/test/instructions.test.ts` | D | rendered snippets match the adapter config shape |
| `apps/cli/src/init.ts` | D | `runInit` orchestration (discovery → confirm → write → doctor → smoke → instructions) |
| `apps/cli/test/init.test.ts` | D | end-to-end with `StubDiscovery` + fake IO, exit codes, no host-config writes |
| `apps/cli/src/main.ts` | D | (modify, additive) `init` dispatch + exit-code propagation |
| `scripts/live-init-smoke.mjs` | D | operator-gated live smoke against a real server (never CI) |
| `packages/core/src/index.ts` | B+C+D | **shared barrel** — one additive export line per group |

## Dependency choice (required coverage: name the TOML library and justify it)

**Chosen: `smol-toml` — already present, no new dependency is added.**

- It is **already a direct dependency of `@tinystrap/core`**: `packages/core/package.json` lists `"smol-toml": "^1.3.0"`, and `pnpm-lock.yaml` pins a single version, `smol-toml@1.8.0` (importer entry at line 68, resolution at line 493, snapshot at line 909). It is the **only** TOML library anywhere in the lockfile — a grep for `smol-toml|@iarna/toml|js-toml|toml` returns those three lines and nothing else.
- It is already the parse side of the config loader: `packages/core/src/config.ts:3` does `import { parse } from "smol-toml"`, and `readToml` (`:35-43`) is what turns a malformed file into the actionable `bad TOML in <path>: <message>` error. Reusing it means the writer and the reader cannot disagree about syntax.
- **Its actual behavior drives the design.** `smol-toml` parses to a plain object and `stringify`s back to TOML text, but it carries no comment or ordering metadata — a `parse` → `stringify` round trip **drops every comment**. So the writer must not be a round trip. Task 4 renders a **comment-bearing template string** and validates it by parsing the rendered text back with the same `parse`; Task 5 never rewrites an existing file at all.
- That is what satisfies the brief's "keeps comments if the toml lib allows else documents the limitation": it does not, and the limitation is avoided rather than papered over. Because the only write path is *create a new file* (or an explicit `--force` overwrite), user comments and key order in an existing file are preserved by **not touching the file** — there is no code path that round-trips an existing file through the parser.
- Rejected alternatives: `@iarna/toml` and `js-toml` are not in the lockfile and would add a second TOML implementation to a repo whose whole point is one config file; a comment-preserving library (e.g. `smol-toml`'s forks or `@iarna/toml`'s cursor API) is not needed for a renderer that emits its own comments and refuses to rewrite.

## Exit codes (required coverage)

Set by `apps/cli/src/main.ts` via `process.exitCode`; `runInit` returns a code rather than calling `process.exit` so it stays testable.

| Code | Name | When |
| ---- | ---- | ---- |
| `0` | ok | Config written (or already present under `--force`), doctor ran, smoke passed (or `--no-smoke`). |
| `1` | internal | An unexpected throw — a bug, or a filesystem error that is not one of the actionable cases below. |
| `2` | usage | Unknown flag, missing flag value, malformed `--url`, or `--force` given where it has no meaning. The message names the offending flag and the correct form. |
| `3` | no-server | Discovery found nothing reachable. Per spec §14, the output must list every endpoint probed, every port, and what each returned. |
| `4` | config-exists | `tinystrap.toml` already exists and `--force` was not passed. Nothing was written. |
| `5` | smoke-failed | The config was written and doctor ran, but the tool-call smoke test did not produce a forwarded tool call. |
| `130` | interrupted | SIGINT during a prompt or a smoke test. |

`130` is the conventional shell code for SIGINT and is used here so a scripted caller can tell "the operator pressed Ctrl-C" apart from "the smoke test failed".

## Error messages a non-expert can act on (required coverage)

Every user-visible failure answers three questions: **what was attempted**, **what happened**, and **what to do next**. No message may contain a raw stack trace or an internal type name.

| Situation | Message shape (exact strings live in the tasks) |
| --------- | --------------------------------------------- |
| Nothing answered | `no model server answered. probed: http://127.0.0.1:8080/props (ECONNREFUSED), http://127.0.0.1:8080/v1/models (ECONNREFUSED), ... Start your model server, or re-run with --url http://127.0.0.1:<port>.` |
| Server answered, no models | `server at <url> responded but listed no models. Load a model, or pass --model <id>.` |
| `--model` is not on the server | `--model <id> is not served by <url>, which offers: a, b. Pick one of these, or start a server that has it.` |
| Config exists, no `--force` | `<dir>/tinystrap.toml already exists. tinystrap init never overwrites it. Re-run with --force to replace it, or edit the file by hand.` |
| Smoke got no tool call | `smoke test failed: the model answered without calling the probe tool (<reason>). The proxy is up but the model may not support tool calls. See the setup notes printed below.` |
| Context length unknown | `could not determine the context length for <model>; leaving context.length unset. Set [context] length in <file> if you know it.` |

Rationale: the no-server case is mandated by spec §14 ("`tinystrap doctor` explains exactly which was probed and what failed") and the no-models / unknown-`--model` cases are its natural siblings — a first-time user who has a server up but no model pulled should never have to read source to learn that.

## Windows path handling (required coverage)

- **All paths are built with `node:path`, never string concatenation.** `join(projectRoot, "tinystrap.toml")` — no `"/"`, no `"\\"`, no `+`. Task 5's tests construct the project root with `mkdtempSync(join(tmpdir(), "ts-init-"))` and assert the written file with `existsSync(join(dir, "tinystrap.toml"))`.
- **`--dir` is resolved, not assumed.** Task 9 applies `resolve()` to the flag value so a relative `--dir` behaves the same as the implicit `process.cwd()`; the existing `--cwd` flag (which `main.ts:14` reads raw) is left alone.
- **A path with a space and a backslash-containing segment must round-trip.** Task 5 includes a case whose directory name contains a space, asserting the message and the written file both name the real path — the failure mode this guards against is a hand-built message that reads like `C:\path with space/tinystrap.toml` but was assembled with forward slashes.
- **The file path never appears inside TOML.** Only the base URL is written to `tinystrap.toml` (§7 keeps project paths out of config), so no Windows path needs TOML `\` escaping. The renderer writes URLs, model ids, and integers only.
- **Loopback URL parsing is host-agnostic.** `isLoopbackUrl` compares `new URL(u).hostname` against `127.0.0.1`, `localhost`, and `[::1]` — the exact triple `adapters/opencode/src/config.ts:12` already uses. A Windows-only path quirk that does exist: `%APPDATA%/tinystrap/defaults.toml` is the user-defaults location on Windows per spec §7, but this plan **does not read or write it** (deferred), so there is no platform-conditional path code to get wrong.

## Interfaces consumed (verified against the code on `main`, 2026-09-25)

```ts
// @tinystrap/discovery (packages/discovery/src/index.ts)
export type ServerKind = "llamacpp" | "ollama" | "lmstudio" | "openai-compatible";
export type DiscoveredModel = { id: string; contextLength?: number };
export type DiscoveredServer = { baseUrl: string; kind: ServerKind; models: DiscoveredModel[] };
export type DiscoveredValues = {
  servers: DiscoveredServer[];
  selectedModel?: string;
  contextLength?: number;
  // Task 1 ADDS two optional fields; every existing construction site stays valid:
  attempts?: ProbeAttempt[];
  probeSource?: "loopback" | "url";
};
export interface Discovery { probe(): Promise<DiscoveredValues>; }
export class StubDiscovery implements Discovery {          // index.ts:20
  constructor(values: DiscoveredValues);
  probe(): Promise<DiscoveredValues>;
}

// packages/discovery/src/llamacpp.ts — Task 3 reuses these, unchanged
export function identifyLlamaCpp(propsBody: unknown, modelsBody: unknown): boolean;  // :17
export function extractLlamaCppFacts(propsBody: unknown): LlamaCppFacts | null;       // :29
export type LlamaCppFacts = { modelAlias: string; nCtx: number; buildInfo: string;
  totalSlots: number; chatTemplateCaps: Record<string, boolean> };                    // :3
type FetchLike = (url: string) => Promise<{ status: number; json(): Promise<unknown> }>;
// NOTE: FetchLike is NOT exported (llamacpp.ts:11). Task 2 declares and exports an
// identical `ProbeFetch` from local.ts; the shapes are structurally compatible, so
// a test double written for one satisfies the other.

// @tinystrap/core (packages/core/src)
export async function loadConfig(opts: { projectRoot: string; userDefaultsPath?: string;
  discovered?: DiscoveredValues; cli?: Record<string, unknown> }): Promise<ResolvedConfig>;
  // config.ts:45. BUILTIN (:10) defines server.baseUrl / server.model / promotion.mode /
  // snapshot.allowIgnoredDirs / verify.test. KEY_MAP (:18) maps base_url -> baseUrl and
  // allow_ignored_dirs -> allowIgnoredDirs; discovered values are applied at :60-67.
export async function runDoctor(projectRoot: string, discovery: Discovery,
  cliFlags?: Record<string, unknown>): Promise<string>;    // doctor.ts:4
// runDoctor already catches a probe rejection and prints "discovery failed: <msg>"
// (doctor.ts:26-27) and already prints one "key = value   (source)" line per resolved
// value (:19-24). Task 6 EXTENDS it; it does not replace this format, which
// core/test/doctor.test.ts:17-19 asserts.

// @tinystrap/proxy (packages/proxy/src) — consumed by the smoke test (Task 8)
export async function startProxy(deps: ProxyDeps, port = 0):
  Promise<{ url: string; close: () => Promise<void> }>;    // server.ts:46-69
// startProxy binds 127.0.0.1 unconditionally (server.ts:61) and returns
// `http://127.0.0.1:<port>`. Serves ONLY POST */v1/chat/completions (server.ts:53).
export type ProxyDeps = { provider: Provider; registry: ToolRegistry;
  preflight: Preflight; onEvent?: (e: HarnessEvent) => void;
  features?: Partial<ProxyFeatures>; taskId?: string; budgetTokens?: number;
  serverCaps?: Record<string, boolean> | null; phase?: () => Phase;
  dialect?: HostDialect; phaseAllowlists?: Partial<Record<Phase, readonly string[]>>;
  maxInterruptRetries?: number; maxPinNoteTurns?: number };   // server.ts:21-44
export class FakeProvider implements Provider {               // fakeprovider.ts:4
  constructor(streams: RecordedStream[]);   // THROWS on an empty array (:8)
  reset(): void;
  stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamChunk>;
}
export type RecordedStream = { server: string; attempt: string; status: number;
  chunks: StreamChunk[]; summary: Record<string, unknown> };   // fixtures.ts:5-8
export class HttpProvider implements Provider {                // httpprovider.ts:4
  constructor(opts: { baseUrl: string });
}
// HttpProvider is the LIVE path only (Task 12). It targets
// `${baseUrl}/v1/chat/completions` and is deliberately not loopback-restricted.

// @tinystrap/policy
export function createToolRegistry(): ToolRegistry;            // used to seed the proxy
export function evaluate(req: ToolRequest, ctx: PolicyContext): PolicyDecision;

// @tinystrap/proxy profile seam — Task 6 takes the resolver as a CALLBACK, so core
// never imports proxy at runtime:
export function selectProfile(modelId: string,
  profiles?: readonly ModelProfile[]): ModelProfile;           // profiles.ts:34

// adapters/opencode — Task 10 must print a config matching this shape
export function buildOpenCodeConfig(proxyBaseUrl: string, modelId: string):
  OpenCodeProviderConfig;                                      // config.ts:10
export type OpenCodeProviderConfig = { provider: Record<string, { npm: string;
  name: string; options: { baseURL: string; apiKey: string };
  models: Record<string, Record<string, never>> }> };
// Throws unless the hostname is 127.0.0.1 / localhost / [::1] (config.ts:12-13).

// apps/cli/src/main.ts
export async function runCli(argv: string[], discovery?: Discovery): Promise<string>;
  // main.ts:13. Today it returns a STRING and main.ts:45-48 prints it and sets
  // process.exitCode = 1 on any throw. Task 11 adds the `init` branch; the existing
  // branches and the throw-to-exit-1 behavior are untouched.
```

## Spec-vs-code gaps found while writing this plan (audit results, report upstream)

Evidence is `file:line` on `main` (`1efbcd3`).

1. **A failed probe explains nothing.** `LlamaCppDiscovery.probe` (`llamacpp.ts:56-75`) awaits two fetches and lets any rejection escape as a raw `TypeError: fetch failed`; a connection refusal and a 404 are indistinguishable to the caller, and nothing records which endpoints were tried. Spec §14 requires doctor to "explain exactly which endpoints on which ports were probed and what each returned". Group A's `ProbeAttempt[]` and Group C's probe table close this.
2. **Nothing probes Ollama or LM Studio, and nothing sweeps ports.** `packages/discovery/src` contains only `llamacpp.ts`; `index.ts:18` re-exports that one module. There is no port list and no `LocalDiscovery`, so "zero-input discovery" is not reachable today even for llama.cpp — the user must already know a port. Group A adds the sweep.
3. **`DiscoveredValues` cannot carry a probe history.** `index.ts:8-12` has exactly three fields, so adding attempt reporting is a breaking change unless the new fields are optional. Task 1 makes them optional precisely so `StubDiscovery` and the existing tests keep compiling.
4. **There is no config writer at all.** `config.ts` only reads (`readToml`, `loadConfig`), and nothing in the repo writes `tinystrap.toml`. Spec §7 makes the one-file config a hard requirement and lists what it must contain, but there is no code path that creates it. Group B is that path, and it is the first thing `tinystrap init` does after confirming a model.
5. **No tool-call smoke test exists, and `FakeProvider` has never been driven through the real server for one.** `FakeProvider` is used in proxy unit tests, but no test asserts "a tool call offered by the client survives the proxy and comes back as a `tool_call`". That single assertion is the whole point of an init-time smoke test (it catches a model that cannot emit tool calls, and a proxy that interrupts them). Group C adds it against the real `startProxy`.
6. **`doctor` reports no probe detail and no profile.** `doctor.ts:19-36` prints resolved keys, a discovery-failure line, and either a server list or `no servers discovered`. Spec §8.1 also requires "selected model and profile" and the §14 probe explanation. Task 6 adds both as additive output; the existing `key = value   (source)` lines that `core/test/doctor.test.ts` asserts stay exactly as they are.
7. **`runCli` cannot express an exit code.** `main.ts:13` returns a `string`; the only exit behavior is `process.exitCode = 1` when it throws (`main.ts:46-48`). A clean `--force`-refused, no-server, or smoke-failed outcome needs distinct codes, and throwing would print a bare message with code 1. Task 11 changes the `init` branch only and leaves the other branches' signatures alone.
8. **Discovery has no injectable `fetch` at the interface level.** `LlamaCppDiscovery` takes an optional `fetchImpl` (`llamacpp.ts:52`) and `StubDiscovery` returns canned values, but the `Discovery` interface itself exposes only `probe()`. Group A follows the existing `fetchImpl` precedent instead of changing the interface, so no consumer is affected.

---

### Task 1 [Group A]: `ProbeAttempt`, the optional fields on `DiscoveredValues`, and the loopback port policy

**Files:**
- Create: `packages/discovery/src/local.ts`
- Modify: `packages/discovery/src/index.ts` (one new type above `DiscoveredValues`, two optional fields, one export line)
- Test: `packages/discovery/test/local.test.ts`

**Interfaces:**
- Consumes: nothing. `local.ts` imports only from `./index.js` for the `Discovery` type, which it does not need yet.
- Produces (exported from `@tinystrap/discovery`):

```ts
export type ProbeAttempt = {
  url: string;
  outcome: "ok" | "http-error" | "unreachable";
  status?: number;
  detail?: string;   // short human phrase, never a stack trace
};
// added to index.ts, both OPTIONAL so every existing construction site keeps compiling:
export type DiscoveredValues = {
  servers: DiscoveredServer[];
  selectedModel?: string;
  contextLength?: number;
  attempts?: ProbeAttempt[];          // new
  probeSource?: "loopback" | "url";   // new
};
// local.ts
export const LOCAL_PORTS: readonly number[];
export function isLoopbackUrl(url: string): boolean;
export function localTargets(ports?: readonly number[]): string[];
```

Steps:

- [ ] Create `packages/discovery/test/local.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { LOCAL_PORTS, isLoopbackUrl, localTargets } from "@tinystrap/discovery";

describe("loopback port policy", () => {
  it("probes the three default local servers, in a fixed order", () => {
    // 8080 llama.cpp, 11434 Ollama, 1234 LM Studio - the three local servers in
    // spec section 8. Fixed order so probe output is reproducible.
    expect(LOCAL_PORTS).toEqual([8080, 11434, 1234]);
    expect(localTargets()).toEqual([
      "http://127.0.0.1:8080",
      "http://127.0.0.1:11434",
      "http://127.0.0.1:1234",
    ]);
  });
  it("accepts every loopback spelling and nothing else", () => {
    expect(isLoopbackUrl("http://127.0.0.1:8080")).toBe(true);
    expect(isLoopbackUrl("http://localhost:1234")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:1234")).toBe(true);
    expect(isLoopbackUrl("http://example.invalid:8080")).toBe(false);
    expect(isLoopbackUrl("not a url")).toBe(false);
    expect(isLoopbackUrl("")).toBe(false);
  });
  it("every default target is loopback", () => {
    // The global constraint, asserted: the sweep can never leave the machine.
    for (const t of localTargets()) expect(isLoopbackUrl(t)).toBe(true);
  });
});
```

- [ ] Run `pnpm test -- local`. Expected: FAIL - `LOCAL_PORTS` / `isLoopbackUrl` / `localTargets` are not exported from `@tinystrap/discovery`.
- [ ] Create `packages/discovery/src/local.ts` with exactly:

```ts
// Loopback-only discovery policy. `init` must work with zero input, so the port
// list is fixed and loopback-only; a non-loopback address is reachable ONLY when the
// operator supplies it as `--url` (Task 9), never as a default.
export const LOCAL_PORTS: readonly number[] = [8080, 11434, 1234];

// Same three hostnames adapters/opencode/src/config.ts:12 already accepts. WHATWG
// URL keeps IPv6 literals bracketed, hence the "[::1]" spelling.
export function isLoopbackUrl(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  return u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
}

export function localTargets(ports: readonly number[] = LOCAL_PORTS): string[] {
  return ports.map((p) => `http://127.0.0.1:${p}`);
}
```

- [ ] Add `ProbeAttempt` to `packages/discovery/src/index.ts` immediately above `DiscoveredValues`, add `attempts?: ProbeAttempt[];` and `probeSource?: "loopback" | "url";` to that type, and add `export * from "./local.js";` after the existing `export * from "./llamacpp.js";` line.
- [ ] Run `pnpm test -- local` + `pnpm typecheck`. Expected: PASS, and `packages/discovery/test/stub.test.ts` / `llamacpp.test.ts` still pass unchanged (the new fields are optional, so their object literals are still valid).
- [ ] Commit:

```bash
git add packages/discovery/src/local.ts packages/discovery/src/index.ts packages/discovery/test/local.test.ts
git commit -m "feat(discovery): loopback port policy and probe-attempt reporting

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2 [Group A]: `LocalDiscovery` sweeps the targets and records every attempt

**Files:**
- Modify: `packages/discovery/src/local.ts` (append `ProbeFetch`, `LocalDiscovery`, `describeAttempts`)
- Test: `packages/discovery/test/local.test.ts` (append a `describe` block)

**Interfaces:**
- Consumes: `Discovery`, `DiscoveredValues`, `ProbeAttempt`, `localTargets` (all from Task 1, same file for the first three).
- Produces:

```ts
export type ProbeFetch =
  (url: string) => Promise<{ status: number; json(): Promise<unknown> }>;
export function describeAttempts(attempts: readonly ProbeAttempt[]): string;
export class LocalDiscovery implements Discovery {
  constructor(opts?: { targets?: readonly string[]; fetchImpl?: ProbeFetch });
  probe(): Promise<DiscoveredValues>;
}
```

Steps:

- [ ] Append to `packages/discovery/test/local.test.ts`:

```ts
import { LocalDiscovery, describeAttempts } from "@tinystrap/discovery";
import type { ProbeFetch } from "@tinystrap/discovery";

function refuse(): ProbeFetch {
  return async () => {
    throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  };
}

describe("LocalDiscovery sweep", () => {
  it("records one attempt per endpoint per target and explains a total miss", async () => {
    const values = await new LocalDiscovery({ fetchImpl: refuse() }).probe();
    expect(values.servers).toEqual([]);
    expect(values.probeSource).toBe("loopback");
    // Two routes per target (spec section 8: /props and /v1/models) x three targets.
    expect(values.attempts).toHaveLength(6);
    expect(values.attempts?.every((a) => a.outcome === "unreachable")).toBe(true);
    expect(values.attempts?.[0].url).toBe("http://127.0.0.1:8080/props");
    expect(values.attempts?.[0].detail).toBe("ECONNREFUSED");
  });
  it("distinguishes a live endpoint from a dead one", async () => {
    const fetchImpl: ProbeFetch = async (url) => {
      if (new URL(url).port === "8080" && new URL(url).pathname === "/v1/models") {
        return { status: 200, json: async () => ({ data: [{ id: "m-a" }] }) };
      }
      if (new URL(url).port === "8080") return { status: 404, json: async () => ({}) };
      throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    };
    const values = await new LocalDiscovery({ fetchImpl }).probe();
    const byUrl = Object.fromEntries((values.attempts ?? []).map((a) => [a.url, a]));
    expect(byUrl["http://127.0.0.1:8080/props"].outcome).toBe("http-error");
    expect(byUrl["http://127.0.0.1:8080/props"].status).toBe(404);
    expect(byUrl["http://127.0.0.1:8080/v1/models"].outcome).toBe("ok");
    expect(byUrl["http://127.0.0.1:11434/props"].outcome).toBe("unreachable");
    // No classification yet: Task 3 turns a 200 /v1/models body into a server.
    expect(values.servers).toEqual([]);
  });
  it("describeAttempts names every endpoint and its result, for a non-expert", () => {
    const text = describeAttempts([
      { url: "http://127.0.0.1:8080/props", outcome: "http-error", status: 404 },
      { url: "http://127.0.0.1:8080/v1/models", outcome: "unreachable", detail: "ECONNREFUSED" },
    ]);
    expect(text).toBe("probed: http://127.0.0.1:8080/props (404), http://127.0.0.1:8080/v1/models (ECONNREFUSED)");
  });
});
```

- [ ] Run `pnpm test -- local`. Expected: FAIL - `LocalDiscovery` / `describeAttempts` are not exported.
- [ ] Append to `packages/discovery/src/local.ts`:

```ts
import type { Discovery, DiscoveredValues, ProbeAttempt } from "./index.js";

export type ProbeFetch =
  (url: string) => Promise<{ status: number; json(): Promise<unknown> }>;

// Structurally identical to llamacpp.ts's unexported FetchLike, so a double written
// for either satisfies the other.
const defaultProbeFetch: ProbeFetch = async (url) => {
  const res = await fetch(url);
  return { status: res.status, json: () => res.json() as Promise<unknown> };
};

// Spec section 14: doctor must explain exactly which endpoints were probed and what
// each returned. One line, comma separated, no internal type names.
export function describeAttempts(attempts: readonly ProbeAttempt[]): string {
  const body = attempts
    .map((a) => `${a.url} (${a.status ?? a.detail ?? a.outcome})`)
    .join(", ");
  return body ? `probed: ${body}` : "probed nothing";
}

async function attempt(
  fetchImpl: ProbeFetch, url: string,
): Promise<{ attempt: ProbeAttempt; body: unknown }> {
  try {
    const res = await fetchImpl(url);
    return {
      attempt: { url, outcome: res.status === 200 ? "ok" : "http-error", status: res.status },
      body: res.status === 200 ? await res.json() : {},
    };
  } catch (err) {
    // A refusal and a DNS failure must read differently to the user than a 404.
    const detail = (err as { cause?: { code?: string } })?.cause?.code
      ?? (err as Error).message;
    return { attempt: { url, outcome: "unreachable", detail: String(detail) }, body: {} };
  }
}

export class LocalDiscovery implements Discovery {
  constructor(
    private readonly opts: { targets?: readonly string[]; fetchImpl?: ProbeFetch } = {},
  ) {}

  async probe(): Promise<DiscoveredValues> {
    const fetchImpl = this.opts.fetchImpl ?? defaultProbeFetch;
    const targets = this.opts.targets ?? localTargets();
    const attempts: ProbeAttempt[] = [];
    const bodies: Array<{ base: string; props: unknown; models: unknown }> = [];
    for (const base of targets) {
      const props = await attempt(fetchImpl, `${base}/props`);
      const models = await attempt(fetchImpl, `${base}/v1/models`);
      attempts.push(props.attempt, models.attempt);
      bodies.push({ base, props: props.body, models: models.body });
    }
    // Task 3 classifies `bodies` into `servers`; until then a responder is recorded
    // but not offered, which is what the second test above asserts.
    return { servers: [], attempts, probeSource: "loopback" };
  }
}
```

- [ ] Run `pnpm test -- local` + `pnpm typecheck`. Expected: PASS. `describeAttempts` with an empty array returns `probed nothing` so a caller never emits a dangling `probed:`.
- [ ] Commit:

```bash
git add packages/discovery/src/local.ts packages/discovery/test/local.test.ts
git commit -m "feat(discovery): LocalDiscovery sweeps loopback targets and records every attempt

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3 [Group A]: classify each responder into a server, model list, and context length

**Files:**
- Modify: `packages/discovery/src/local.ts` (`classifyResponder` + use it in `probe`)
- Test: `packages/discovery/test/local.test.ts` (append a `describe` block)

**Interfaces:**
- Consumes: `identifyLlamaCpp`, `extractLlamaCppFacts`, `LlamaCppFacts` from `./llamacpp.js` (existing, unchanged); `DiscoveredServer` from `./index.js`.
- Produces:

```ts
export function classifyResponder(base: string, props: unknown, models: unknown):
  DiscoveredServer | null;
```

Steps:

- [ ] Append to `packages/discovery/test/local.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyResponder } from "@tinystrap/discovery";

// The recorded llama.cpp bodies (spec section 8: /props carries model_alias,
// default_generation_settings.n_ctx, build_info, total_slots, chat_template_caps).
// The same fixture packages/discovery/test/llamacpp.test.ts:6-7 already reads.
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

describe("responder classification", () => {
  it("identifies llama.cpp and takes model, context length, and kind from it", () => {
    const s = classifyResponder("http://127.0.0.1:8080", recorded()["/props"], recorded()["/v1/models"]);
    expect(s).not.toBeNull();
    expect(s?.kind).toBe("llamacpp");
    expect(s?.baseUrl).toBe("http://127.0.0.1:8080");
    expect(s?.models[0].contextLength).toBe(128000);
    // llama.cpp reports model_alias as the full GGUF path, so the id contains
    // slashes. Assert against the recorded fixture rather than a literal.
    const recordedIds = ((recorded()["/v1/models"] as { data: Array<{ id: string }> }).data)
      .map((e) => e.id);
    expect(s?.models.map((m) => m.id)).toEqual(recordedIds);
  });
  it("falls back to openai-compatible for an ambiguous /v1/models responder", () => {
    // Spec section 8 marks Ollama and LM Studio identification "to verify", so an
    // unidentified OpenAI-shaped responder is labelled, never guessed at.
    const s = classifyResponder("http://127.0.0.1:1234", {}, { data: [{ id: "m-a" }, { id: "m-b" }] });
    expect(s?.kind).toBe("openai-compatible");
    expect(s?.models.map((m) => m.id)).toEqual(["m-a", "m-b"]);
    // No /props means no n_ctx: never invent a context length.
    expect(s?.models[0].contextLength).toBeUndefined();
  });
  it("rejects a listener that answers 404 or with no models", () => {
    expect(classifyResponder("http://127.0.0.1:9000", {}, {})).toBeNull();
    expect(classifyResponder("http://127.0.0.1:9000", {}, { data: [] })).toBeNull();
  });
  it("probe() now offers the discovered server, with context length and selection", async () => {
    const bodies = recorded();
    const fetchImpl: ProbeFetch = async (url) => {
      const body = bodies[new URL(url).pathname];
      return body
        ? { status: 200, json: async () => body }
        : { status: 404, json: async () => ({}) };
    };
    const values = await new LocalDiscovery({
      targets: ["http://127.0.0.1:8080"], fetchImpl,
    }).probe();
    expect(values.servers).toHaveLength(1);
    expect(values.selectedModel).toBe(values.servers[0].models[0].id);
    expect(values.contextLength).toBe(128000);
    expect(values.probeSource).toBe("loopback");
  });
});
```

- [ ] Run `pnpm test -- local`. Expected: FAIL - `classifyResponder` is not exported, and `probe()` still returns `servers: []`.
- [ ] Add to `packages/discovery/src/local.ts`:

```ts
import { identifyLlamaCpp, extractLlamaCppFacts } from "./llamacpp.js";
import type { DiscoveredServer } from "./index.js";

function idsOf(modelsBody: unknown): string[] {
  if (typeof modelsBody !== "object" || modelsBody === null) return [];
  const data = (modelsBody as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return data
    .filter((e): e is { id: string } =>
      typeof e === "object" && e !== null && typeof (e as { id?: unknown }).id === "string")
    .map((e) => e.id);
}

export function classifyResponder(base: string, props: unknown, models: unknown):
  DiscoveredServer | null {
  // llama.cpp first: it is the only server whose context length we can read, and
  // identifyLlamaCpp already excludes foreign responders by response shape.
  if (identifyLlamaCpp(props, models)) {
    const facts = extractLlamaCppFacts(props);
    const ids = idsOf(models);
    return {
      baseUrl: base, kind: "llamacpp",
      models: (ids.length > 0 ? ids : facts ? [facts.modelAlias] : [])
        .map((id) => ({ id, contextLength: facts?.nCtx })),
    };
  }
  const ids = idsOf(models);
  return ids.length > 0 ? { baseUrl: base, kind: "openai-compatible", models: ids.map((id) => ({ id })) } : null;
}
```

  and replace the `return { servers: [], attempts, probeSource: "loopback" };` line in `probe()` with:

```ts
    const servers = bodies
      .map((b) => classifyResponder(b.base, b.props, b.models))
      .filter((s): s is DiscoveredServer => s !== null);
    const first = servers[0];
    return {
      servers,
      selectedModel: first?.models[0]?.id,
      contextLength: first?.models[0]?.contextLength,
      attempts,
      // Honest by construction: the same class serves the default loopback sweep and
      // the single operator-supplied `--url` target, and says which it was.
      probeSource: targets.every(isLoopbackUrl) ? "loopback" : "url",
    };
```

  and append one test to the same `describe` block, so the `--url` path is not mislabelled:

```ts
  it("probeSource is url when the operator supplied a non-loopback target", async () => {
    const bodies = recorded();
    const fetchImpl: ProbeFetch = async (url) => {
      const body = bodies[new URL(url).pathname];
      return body
        ? { status: 200, json: async () => body }
        : { status: 404, json: async () => ({}) };
    };
    const values = await new LocalDiscovery({
      targets: ["http://example.invalid:8080"], fetchImpl,
    }).probe();
    expect(values.probeSource).toBe("url");
    expect(values.servers).toHaveLength(1);
  });
```

- [ ] Run `pnpm test -- local` + `pnpm typecheck`. Expected: PASS. `packages/discovery/test/llamacpp.test.ts` is untouched and still green.
- [ ] Commit:

```bash
git add packages/discovery/src/local.ts packages/discovery/test/local.test.ts
git commit -m "feat(discovery): classify loopback responders into servers, models, and context length

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4 [Group B]: `renderInitToml` — a comment-bearing, self-validating `tinystrap.toml`

**Files:**
- Create: `packages/core/src/init-toml.ts`
- Modify: `packages/core/src/index.ts` (one additive export line)
- Test: `packages/core/test/init-toml.test.ts`

**Interfaces:**
- Consumes: `ServerKind` from `@tinystrap/discovery` (already a `core` dependency, `packages/core/package.json:8`). `smol-toml`'s `parse` — the same import `packages/core/src/config.ts:3` already makes. `KEY_MAP` (`config.ts:18-22`) dictates the on-disk key spellings below.
- Produces:

```ts
export type InitTomlValues = {
  baseUrl: string;
  model: string;
  kind: ServerKind;
  contextLength?: number;
  promotionMode?: "apply" | "export_patch" | "commit_task_branch" | "open_pr";
};
export function renderInitToml(values: InitTomlValues): string;
```

Steps:

- [ ] Create `packages/core/test/init-toml.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parse } from "smol-toml";
import { renderInitToml } from "@tinystrap/core";

const values = {
  baseUrl: "http://127.0.0.1:8080", model: "m-a", kind: "llamacpp" as const,
  contextLength: 8192,
};

describe("init config renderer", () => {
  it("emits the keys the loader actually reads, verified through the same parser", () => {
    const parsed = parse(renderInitToml(values)) as Record<string, Record<string, unknown>>;
    // snake_case on disk, camelCase after KEY_MAP (config.ts:18-22): base_url -> baseUrl.
    expect(parsed.server.base_url).toBe("http://127.0.0.1:8080");
    expect(parsed.server.model).toBe("m-a");
    // [context] length flattens to context.length, the same key discovery sets (config.ts:65).
    expect(parsed.context.length).toBe(8192);
    expect(parsed.promotion.mode).toBe("apply");
  });
  it("keeps the comments that explain each table", () => {
    const text = renderInitToml(values);
    expect(text.startsWith("#")).toBe(true);
    expect(text).toContain("# tinystrap.toml");
    expect(text).toContain("base_url");
    expect(text).toContain("# Where the model server lives");
  });
  it("omits the context table entirely when the length is unknown", () => {
    // Never invent a context length: an absent table falls back to discovery.
    const text = renderInitToml({ ...values, contextLength: undefined });
    expect(text).not.toContain("[context]");
    expect(parse(text) as Record<string, unknown>).not.toHaveProperty("context");
  });
  it("escapes a model id that contains quotes or backslashes", () => {
    // llama.cpp reports model_alias as a full GGUF path, so ids carry slashes; a
    // quoting bug here would produce a file loadConfig cannot read.
    const odd = 'm"x\\y';
    const parsed = parse(renderInitToml({ ...values, model: odd })) as {
      server: { model: string } };
    expect(parsed.server.model).toBe(odd);
  });
});
```

- [ ] Run `pnpm test -- init-toml`. Expected: FAIL - `renderInitToml` is not exported from `@tinystrap/core`.
- [ ] Create `packages/core/src/init-toml.ts` with exactly:

```ts
import type { ServerKind } from "@tinystrap/discovery";
import { parse } from "smol-toml";

export type InitTomlValues = {
  baseUrl: string;
  model: string;
  kind: ServerKind;
  contextLength?: number;
  promotionMode?: "apply" | "export_patch" | "commit_task_branch" | "open_pr";
};

// A TOML basic string. The only escaping smol-toml's parser needs for a value that
// came off a server: backslash and double quote.
function q(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// Rendered as text, never produced by parse -> stringify: smol-toml carries no
// comment or ordering metadata, so a round trip would drop every comment below.
// The loader (config.ts:18-22) is the contract these key spellings must match.
export function renderInitToml(values: InitTomlValues): string {
  const lines = [
    "# tinystrap.toml - written by `tinystrap init`.",
    "# The one config file tinystrap reads (spec section 7). Edit it freely:",
    "# `tinystrap init` never rewrites this file unless you pass --force.",
    "",
    "[server]",
    "# Where the model server lives. Discovered on this machine; point it",
    "# somewhere else here if you need to.",
    `base_url = ${q(values.baseUrl)}`,
    `model = ${q(values.model)}`,
    "",
  ];
  if (values.contextLength !== undefined) {
    lines.push(
      "[context]",
      "# Context length (n_ctx) reported by the server for this model.",
      "# Delete this table to fall back to whatever discovery sees at run time.",
      `length = ${values.contextLength}`,
      "",
    );
  }
  lines.push(
    "[promotion]",
    "# apply | export_patch | commit_task_branch | open_pr",
    `mode = ${q(values.promotionMode ?? "apply")}`,
    "",
  );
  const text = lines.join("\n");
  // Fail here, at write time, rather than on the operator's next command.
  parse(text);
  return text;
}
```

- [ ] Add `export * from "./init-toml.js";` to `packages/core/src/index.ts`.
- [ ] Run `pnpm test -- init-toml` + `pnpm typecheck`. Expected: PASS.
- [ ] Commit:

```bash
git add packages/core/src/init-toml.ts packages/core/src/index.ts packages/core/test/init-toml.test.ts
git commit -m "feat(core): render a comment-bearing tinystrap.toml for tinystrap init

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5 [Group B]: `writeInitConfig` — creates once, never clobbers, `--force` to overwrite

**Files:**
- Create: `packages/core/src/init-write.ts`
- Modify: `packages/core/src/index.ts` (one additive export line)
- Test: `packages/core/test/init-write.test.ts`

**Interfaces:**
- Consumes: `renderInitToml` / `InitTomlValues` (Task 4, same package).
- Produces:

```ts
export class ConfigExistsError extends Error {
  readonly path: string;
  constructor(path: string);
  // message: "<path> already exists. tinystrap init never overwrites it.
  //           Re-run with --force to replace it, or edit the file by hand."
}
export type WriteInitResult = { path: string; created: boolean; overwritten: boolean };
export function writeInitConfig(opts: {
  projectRoot: string;
  values: InitTomlValues;
  force?: boolean;
}): WriteInitResult;
```

Steps:

- [ ] Create `packages/core/test/init-write.test.ts`:

```ts
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigExistsError, writeInitConfig } from "@tinystrap/core";

const values = {
  baseUrl: "http://127.0.0.1:8080", model: "m-a", kind: "llamacpp" as const,
  contextLength: 8192,
};
const project = (name = "ts-init-"): string => mkdtempSync(join(tmpdir(), name));

describe("init config writer", () => {
  it("creates the one config file and reports where it went", () => {
    const dir = project();
    const r = writeInitConfig({ projectRoot: dir, values });
    expect(r.created).toBe(true);
    expect(r.overwritten).toBe(false);
    expect(existsSync(join(dir, "tinystrap.toml"))).toBe(true);
    expect(r.path).toBe(join(dir, "tinystrap.toml"));
  });
  it("refuses to clobber an existing file, byte for byte", () => {
    const dir = project();
    const path = join(dir, "tinystrap.toml");
    // A user's own hand-edited file, comments and all.
    const mine = "# mine\n[server]\nmodel = \"hand-picked\"\n";
    writeFileSync(path, mine);
    expect(() => writeInitConfig({ projectRoot: dir, values }))
      .toThrow(ConfigExistsError);
    expect(readFileSync(path, "utf8")).toBe(mine);
  });
  it("the refusal message tells a non-expert exactly what to do", () => {
    const dir = project();
    writeInitConfig({ projectRoot: dir, values });
    try {
      writeInitConfig({ projectRoot: dir, values });
      throw new Error("should have refused");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigExistsError);
      const e = err as ConfigExistsError;
      expect(e.path).toBe(join(dir, "tinystrap.toml"));
      expect(e.message).toContain("never overwrites it");
      expect(e.message).toContain("--force");
    }
  });
  it("force replaces the file and says so", () => {
    const dir = project();
    writeInitConfig({ projectRoot: dir, values });
    const r = writeInitConfig({ projectRoot: dir, values: { ...values, model: "m-b" }, force: true });
    expect(r.overwritten).toBe(true);
    expect(r.created).toBe(false);
    expect(readFileSync(join(dir, "tinystrap.toml"), "utf8")).toContain('model = "m-b"');
  });
  it("is idempotent: a second init without --force changes nothing", () => {
    const dir = project();
    writeInitConfig({ projectRoot: dir, values });
    const before = readFileSync(join(dir, "tinystrap.toml"), "utf8");
    expect(() => writeInitConfig({ projectRoot: dir, values })).toThrow(ConfigExistsError);
    expect(readFileSync(join(dir, "tinystrap.toml"), "utf8")).toBe(before);
  });
  it("handles a project path containing a space, on any platform", () => {
    const dir = project("ts-init-with space-");
    expect(dir).toContain(" ");
    const r = writeInitConfig({ projectRoot: dir, values });
    expect(existsSync(r.path)).toBe(true);
  });
});
```

- [ ] Run `pnpm test -- init-write`. Expected: FAIL - `ConfigExistsError` / `writeInitConfig` are not exported.
- [ ] Create `packages/core/src/init-write.ts` with exactly:

```ts
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderInitToml, type InitTomlValues } from "./init-toml.js";

export class ConfigExistsError extends Error {
  readonly path: string;
  constructor(path: string) {
    // Three answers in one message: what happened, why, what to do next.
    super(
      `${path} already exists. tinystrap init never overwrites it. `
      + "Re-run with --force to replace it, or edit the file by hand.",
    );
    this.name = "ConfigExistsError";
    this.path = path;
  }
}

export type WriteInitResult = { path: string; created: boolean; overwritten: boolean };

export function writeInitConfig(opts: {
  projectRoot: string;
  values: InitTomlValues;
  force?: boolean;
}): WriteInitResult {
  const path = join(opts.projectRoot, "tinystrap.toml");
  // The clobber guard. There is exactly one write path and it refuses by default;
  // --force is the only way an existing file is replaced. Refusing (rather than
  // merging) is also what keeps a user's comments intact: no existing file is ever
  // parsed and re-emitted, because smol-toml cannot carry comments through a
  // round trip.
  if (existsSync(path) && !opts.force) throw new ConfigExistsError(path);
  const existed = existsSync(path);
  writeFileSync(path, renderInitToml(opts.values), "utf8");
  return { path, created: !existed, overwritten: existed };
}
```

- [ ] Add `export * from "./init-write.js";` to `packages/core/src/index.ts`.
- [ ] Run `pnpm test -- init-write` + `pnpm typecheck`. Expected: PASS. The space-in-path case is the Windows guard: the path is built with `join`, never by concatenation, and the refusal message prints the real path.
- [ ] Commit:

```bash
git add packages/core/src/init-write.ts packages/core/src/index.ts packages/core/test/init-write.test.ts
git commit -m "feat(core): writeInitConfig creates tinystrap.toml once and never clobbers it

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6 [Group C]: doctor's probe table and the injected profile resolver

**Files:**
- Modify: `packages/core/src/doctor.ts` (one optional 4th parameter, one new output section, one new line)
- Test: `packages/core/test/doctor-probe.test.ts`

**Interfaces:**
- Consumes: `DiscoveredValues.attempts` / `ProbeAttempt` from `@tinystrap/discovery` (Group A). `Discovery` and `loadConfig` as they are today.
- Produces:

```ts
export type DoctorExtra = {
  // The CLI injects this (it wraps proxy's selectProfile). `core` must NOT import
  // @tinystrap/proxy at runtime, so the resolver arrives as a callback.
  resolveProfile?: (modelId: string) => string | undefined;
};
export async function runDoctor(projectRoot: string, discovery: Discovery,
  cliFlags?: Record<string, unknown>, extra?: DoctorExtra): Promise<string>;
```

Steps:

- [ ] Create `packages/core/test/doctor-probe.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runDoctor } from "@tinystrap/core";
import { StubDiscovery } from "@tinystrap/discovery";
import type { DiscoveredValues } from "@tinystrap/discovery";

const dir = (): string => mkdtempSync(join(tmpdir(), "ts-doc-"));

const withAttempts: DiscoveredValues = {
  servers: [],
  attempts: [
    { url: "http://127.0.0.1:8080/props", outcome: "ok", status: 200 },
    { url: "http://127.0.0.1:11434/props", outcome: "http-error", status: 404 },
    { url: "http://127.0.0.1:1234/v1/models", outcome: "unreachable", detail: "ECONNREFUSED" },
  ],
  probeSource: "loopback",
};

describe("doctor probe reporting", () => {
  it("lists every endpoint probed and what came back (spec 14)", async () => {
    const out = await runDoctor(dir(), new StubDiscovery(withAttempts));
    expect(out).toContain("probe attempts:");
    expect(out).toContain("http://127.0.0.1:8080/props");
    expect(out).toContain("http://127.0.0.1:11434/props");
    expect(out).toContain("ECONNREFUSED");
  });
  it("omits the section entirely when discovery reported no attempts", async () => {
    // Regression guard: the existing doctor.test.ts output shape must not change
    // for any discovery that does not report attempts (e.g. StubDiscovery).
    const out = await runDoctor(dir(), new StubDiscovery({ servers: [] }));
    expect(out).toContain("tinystrap doctor");
    expect(out).not.toContain("probe attempts:");
  });
  it("keeps the existing key = value (source) lines", async () => {
    const out = await runDoctor(dir(), new StubDiscovery({
      servers: [{ baseUrl: "http://127.0.0.1:8080", kind: "llamacpp", models: [{ id: "m-a" }] }],
      selectedModel: "m-a", contextLength: 8192, attempts: withAttempts.attempts,
    }));
    expect(out).toContain("server.model = m-a   (discovered)");
    expect(out).toContain("llamacpp http://127.0.0.1:8080");
    expect(out).toContain("probe attempts:");
  });
  it("prints the selected profile only when a resolver is supplied", async () => {
    const d = { probe: async () => ({ servers: [], selectedModel: "m-a" }) };
    expect(await runDoctor(dir(), d)).not.toContain("profile =");
    const out = await runDoctor(dir(), d, undefined,
      { resolveProfile: (m) => `profile-for-${m}` });
    expect(out).toContain("profile = profile-for-m-a   (profile)");
  });
});
```

- [ ] Run `pnpm test -- doctor`. Expected: FAIL - no `probe attempts:` section exists, and the 4th argument is not accepted.
- [ ] In `packages/core/src/doctor.ts`, add the `DoctorExtra` type above `runDoctor`, change the signature to accept `extra?: DoctorExtra`, and insert this block immediately before the `return lines.join("\n")` at the end of the function:

```ts
  // Spec section 8/14: a failed probe must say which endpoints were tried and what
  // each returned. Only rendered when discovery reported attempts, so the output of
  // every existing doctor call is byte-identical to before.
  if (discovered?.attempts && discovered.attempts.length > 0) {
    lines.push("probe attempts:");
    for (const a of discovered.attempts) {
      lines.push(`  ${a.outcome}  ${a.url}  (${a.status ?? a.detail ?? "-"})`);
    }
  }
  const model = discovered?.selectedModel
    ?? config["server.model"]?.value;
  if (extra?.resolveProfile && typeof model === "string") {
    const name = extra.resolveProfile(model);
    // Spec section 12.1: doctor shows the selected profile and why.
    if (name) lines.push(`profile = ${name}   (profile)`);
  }
```

- [ ] Run `pnpm test -- doctor` + `pnpm typecheck`. Expected: PASS, including the pre-existing `packages/core/test/doctor.test.ts` (its two cases pass no `extra` and its `StubDiscovery` values carry no `attempts`, so its asserted lines are untouched).
- [ ] Commit:

```bash
git add packages/core/src/doctor.ts packages/core/test/doctor-probe.test.ts
git commit -m "feat(core): doctor reports every probed endpoint and the selected profile

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7 [Group C]: `PromptIO` — the confirmation UI, with no TTY anywhere in tests

**Files:**
- Create: `packages/core/src/prompt.ts`
- Modify: `packages/core/src/index.ts` (one additive export line)
- Test: `packages/core/test/prompt.test.ts`

**Interfaces:**
- Consumes: `DiscoveredServer`, `DiscoveredModel` from `@tinystrap/discovery`.
- Produces:

```ts
export type PromptIO = {
  out(line: string): void;
  err(line: string): void;
  ask(question: string): Promise<string>;
  isTty: boolean;
};
export async function pickServer(io: PromptIO,
  servers: readonly DiscoveredServer[]): Promise<DiscoveredServer | null>;
export async function pickModel(io: PromptIO, server: DiscoveredServer,
  preferred?: string): Promise<string | null>;
export function summarizeChoice(io: PromptIO, server: DiscoveredServer, model: string,
  contextLength?: number): void;
```

Steps:

- [ ] Create `packages/core/test/prompt.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { pickModel, pickServer, summarizeChoice } from "@tinystrap/core";
import type { PromptIO } from "@tinystrap/core";
import type { DiscoveredServer } from "@tinystrap/discovery";

// The whole point of PromptIO: a test supplies the terminal. No readline, no TTY.
function fakeIO(answers: string[] = []): PromptIO & { lines: string[]; errors: string[]; asked: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  const asked: string[] = [];
  const queue = [...answers];
  return {
    lines, errors, asked, isTty: true,
    out: (l) => { lines.push(l); },
    err: (l) => { errors.push(l); },
    ask: async (q) => { asked.push(q); return queue.shift() ?? ""; },
  };
}

const a: DiscoveredServer = { baseUrl: "http://127.0.0.1:8080", kind: "llamacpp",
  models: [{ id: "m-a", contextLength: 8192 }] };
const b: DiscoveredServer = { baseUrl: "http://127.0.0.1:1234", kind: "openai-compatible",
  models: [{ id: "m-b" }] };

describe("init prompts", () => {
  it("zero input: one server and one model are taken without asking", async () => {
    const io = fakeIO();
    expect(await pickServer(io, [a])).toBe(a);
    expect(await pickModel(io, a)).toBe("m-a");
    expect(io.asked).toEqual([]);
  });
  it("no server is a null, not a throw", async () => {
    expect(await pickServer(fakeIO(), [])).toBeNull();
  });
  it("asks only when there is a real choice, and validates the answer", async () => {
    const io = fakeIO(["2"]);
    expect(await pickServer(io, [a, b])).toBe(b);
    expect(io.asked[0]).toContain("1)");
    expect(io.asked[0]).toContain("2)");
  });
  it("an out-of-range answer reports the options and returns null", async () => {
    const io = fakeIO(["9"]);
    expect(await pickServer(io, [a, b])).toBeNull();
    expect(io.errors[0]).toContain("1)");
    expect(io.errors[0]).toContain("2)");
  });
  it("--model is accepted when the server serves it", async () => {
    const io = fakeIO();
    expect(await pickModel(io, a, "m-a")).toBe("m-a");
    expect(io.asked).toEqual([]);
  });
  it("--model the server does not serve names what it does serve", async () => {
    const io = fakeIO();
    expect(await pickModel(io, a, "nope")).toBeNull();
    expect(io.errors[0]).toContain("is not served by");
    expect(io.errors[0]).toContain("m-a");
  });
  it("an unknown context length is stated, not invented", () => {
    const io = fakeIO();
    summarizeChoice(io, b, "m-b");
    expect(io.lines.join("\n")).toContain("context length unknown");
  });
});
```

- [ ] Run `pnpm test -- prompt`. Expected: FAIL - `pickServer` / `pickModel` / `summarizeChoice` / `PromptIO` are not exported.
- [ ] Create `packages/core/src/prompt.ts` with exactly:

```ts
import type { DiscoveredModel, DiscoveredServer } from "@tinystrap/discovery";

// The entire terminal surface, injected. `src` never touches process.stdin or
// readline, so every prompt is unit-testable and `--yes` needs no special branch
// in the prompt code - runInit simply supplies an IO whose ask() is never called.
export type PromptIO = {
  out(line: string): void;
  err(line: string): void;
  ask(question: string): Promise<string>;
  isTty: boolean;
};

function numbered(items: readonly string[]): string {
  return items.map((s, i) => `${i + 1}) ${s}`).join("  ");
}

export async function pickServer(
  io: PromptIO, servers: readonly DiscoveredServer[],
): Promise<DiscoveredServer | null> {
  if (servers.length === 0) return null;
  if (servers.length === 1) {
    const s = servers[0];
    io.out(`using server ${s.baseUrl} (${s.kind})`);
    return s;
  }
  io.out("several servers answered:");
  io.out(numbered(servers.map((s) => `${s.baseUrl} (${s.kind})`)));
  const answer = (await io.ask("which one?")).trim();
  const n = Number(answer);
  if (!Number.isInteger(n) || n < 1 || n > servers.length) {
    io.err(`pick one of: ${numbered(servers.map((s) => s.baseUrl))}`);
    return null;
  }
  return servers[n - 1];
}

function modelLine(m: DiscoveredModel): string {
  return m.contextLength === undefined ? m.id : `${m.id} (context ${m.contextLength})`;
}

export async function pickModel(
  io: PromptIO, server: DiscoveredServer, preferred?: string,
): Promise<string | null> {
  const ids = server.models.map((m) => m.id);
  if (preferred !== undefined) {
    if (ids.includes(preferred)) return preferred;
    // Never silently ignore a --model the server cannot serve.
    io.err(`--model ${preferred} is not served by ${server.baseUrl}, which offers: `
      + `${ids.join(", ")}. Pick one of these, or start a server that has it.`);
    return null;
  }
  if (server.models.length === 0) {
    io.err(`server at ${server.baseUrl} responded but listed no models. `
      + "Load a model, or pass --model <id>.");
    return null;
  }
  if (server.models.length === 1) return server.models[0].id;
  io.out("models:");
  io.out(numbered(server.models.map(modelLine)));
  const answer = (await io.ask("which model?")).trim();
  const n = Number(answer);
  if (!Number.isInteger(n) || n < 1 || n > server.models.length) {
    io.err(`pick one of: ${numbered(ids)}`);
    return null;
  }
  return server.models[n - 1].id;
}

export function summarizeChoice(
  io: PromptIO, server: DiscoveredServer, model: string, contextLength?: number,
): void {
  io.out(`server     ${server.baseUrl} (${server.kind})`);
  io.out(`model      ${model}`);
  if (contextLength === undefined) {
    io.out(`context    context length unknown; leaving context.length unset. `
      + "Set [context] length in tinystrap.toml if you know it.");
  } else {
    io.out(`context    ${contextLength}`);
  }
}
```

- [ ] Add `export * from "./prompt.js";` to `packages/core/src/index.ts`.
- [ ] Run `pnpm test -- prompt` + `pnpm typecheck`. Expected: PASS. The `context length unknown` assertion pins the exact wording from the error-message table.
- [ ] Commit:

```bash
git add packages/core/src/prompt.ts packages/core/src/index.ts packages/core/test/prompt.test.ts
git commit -m "feat(core): injected-IO prompts for server, model, and context confirmation

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8 [Group C]: `runSmokeTest` — a real tool call through the real production proxy

**Files:**
- Create: `packages/core/src/smoke.ts`
- Modify: `packages/core/src/index.ts` (one additive export line)
- Modify: `packages/core/package.json` (add a **devDependency**)
- Test: `packages/core/test/smoke.test.ts`

**Interfaces:**
- Consumes: `startProxy`, `FakeProvider`, `RecordedStream` from `@tinystrap/proxy` and `createToolRegistry` from `@tinystrap/policy` — **test file only** (see the dependency note below). At runtime `smoke.ts` needs nothing but `fetch`.
- Produces:

```ts
export type SmokeResult = { ok: boolean; toolCalls: number; detail: string };
export async function runSmokeTest(opts: {
  proxyBaseUrl: string;
  model: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<SmokeResult>;
```

Steps:

- [ ] Add to `packages/core/package.json`:

```json
  "devDependencies": { "@tinystrap/proxy": "workspace:*" }
```

  and run `pnpm install`. **Commit the resulting `pnpm-lock.yaml` change in the same commit** — CI runs `pnpm install --frozen-lockfile`, which fails if the manifest and lockfile disagree. This is a `devDependency` only: `core`'s runtime must not depend on `proxy`, so `smoke.ts` speaks plain HTTP and never imports it. `packages/core/tsconfig.json` needs no new project reference (its `include` is `["src"]`, so the test is outside `tsc -b` and vitest resolves the package through the `default` export condition).
- [ ] Create `packages/core/test/smoke.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FakeProvider, startProxy } from "@tinystrap/proxy";
import type { RecordedStream, StreamChunk } from "@tinystrap/proxy";
import { createToolRegistry } from "@tinystrap/policy";
import { runSmokeTest, SMOKE_TOOL_NAME } from "@tinystrap/core";

// A scripted provider, exactly like the existing proxy tests. The socket is
// loopback to the proxy this test starts - nothing else, and no real server.
function stream(chunks: StreamChunk[]): RecordedStream {
  return { server: "scripted", attempt: "smoke", status: 200, chunks, summary: {} };
}
const toolCallStream = stream([
  { choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1",
      function: { name: SMOKE_TOOL_NAME, arguments: "{\"ok\":true}" } }] },
    finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
]);
const textOnlyStream = stream([
  { choices: [{ index: 0, delta: { role: "assistant", content: "I cannot call tools." },
    finish_reason: "stop" }] },
]);

async function withProxy<T>(provider: FakeProvider, fn: (url: string) => Promise<T>): Promise<T> {
  const proxy = await startProxy({
    provider, registry: createToolRegistry(),
    preflight: () => ({ effect: "allow" as const }),
  });
  try { return await fn(proxy.url); } finally { await proxy.close(); }
}

describe("init smoke test", () => {
  it("passes when one tool call round-trips through the real proxy", async () => {
    const r = await withProxy(new FakeProvider([toolCallStream]),
      (url) => runSmokeTest({ proxyBaseUrl: url, model: "m-a" }));
    expect(r.ok).toBe(true);
    expect(r.toolCalls).toBe(1);
  });
  it("fails, with an actionable reason, when the model answers without calling a tool", async () => {
    const r = await withProxy(new FakeProvider([textOnlyStream]),
      (url) => runSmokeTest({ proxyBaseUrl: url, model: "m-a" }));
    expect(r.ok).toBe(false);
    expect(r.toolCalls).toBe(0);
    expect(r.detail).toContain("without calling");
  });
  it("offers the probe tool, so the model is never asked to guess", () => {
    // The request must carry a tools array: with no tools the proxy forwards none
    // (server.ts:167) and a model cannot call what it was never offered.
    expect(SMOKE_TOOL_NAME).toBe("tinystrap_probe");
  });
});
```

- [ ] Run `pnpm test -- smoke`. Expected: FAIL - `runSmokeTest` / `SMOKE_TOOL_NAME` are not exported.
- [ ] Create `packages/core/src/smoke.ts` with exactly:

```ts
// The init-time smoke test: one request, one tool, through the real proxy.
//
// `core` does not import @tinystrap/proxy at runtime, so this module speaks the
// wire protocol directly rather than reusing the proxy's parseSseRecords. The
// reader below is deliberately tiny; the proxy's own SSE format (sse.ts:19) is
// `data: <json>\n\n` per record.
export const SMOKE_TOOL_NAME = "tinystrap_probe";

const SMOKE_TOOL = {
  type: "function",
  function: {
    name: SMOKE_TOOL_NAME,
    description: "Report that the coding harness is wired up. Always call this.",
    parameters: {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
    },
  },
};

export type SmokeResult = { ok: boolean; toolCalls: number; detail: string };

function toolCallCount(sse: string): number {
  let count = 0;
  for (const block of sse.split(/\r?\n\r?\n/)) {
    for (const line of block.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "" || payload === "[DONE]") continue;
      try {
        const chunk = JSON.parse(payload) as {
          choices?: Array<{ delta?: { tool_calls?: unknown[] } }>;
        };
        if ((chunk.choices?.[0]?.delta?.tool_calls?.length ?? 0) > 0) count += 1;
      } catch {
        // A record we cannot parse is not a tool call; the count stays honest.
      }
    }
  }
  return count;
}

export async function runSmokeTest(opts: {
  proxyBaseUrl: string;
  model: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<SmokeResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.proxyBaseUrl.replace(/\/+$/, "");
  let sse: string;
  try {
    const res = await doFetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: opts.model,
        stream: true,
        messages: [{
          role: "user",
          content: `Call the ${SMOKE_TOOL_NAME} tool with ok: true. `
            + "Do not answer in text.",
        }],
        tools: [SMOKE_TOOL],
        tool_choice: "auto",
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
    if (!res.ok) {
      return { ok: false, toolCalls: 0, detail: `the proxy answered ${res.status}` };
    }
    sse = await res.text();
  } catch (err) {
    return { ok: false, toolCalls: 0,
      detail: `could not reach the proxy at ${base}: ${(err as Error).message}` };
  }
  const toolCalls = toolCallCount(sse);
  if (toolCalls === 0) {
    return { ok: false, toolCalls, detail:
      "the model answered without calling the " + SMOKE_TOOL_NAME
      + " tool. The proxy is up, but this model may not support tool calls. "
      + "Try a chat/instruct model that does, then re-run tinystrap doctor." };
  }
  return { ok: true, toolCalls, detail: `the model called ${SMOKE_TOOL_NAME}` };
}
```

- [ ] Add `export * from "./smoke.js";` to `packages/core/src/index.ts`.
- [ ] Run `pnpm test -- smoke` + `pnpm typecheck`. Expected: PASS. Both tests run against `startProxy` on a real loopback socket with a scripted provider; no external server is contacted.
- [ ] Commit:

```bash
git add packages/core/src/smoke.ts packages/core/src/index.ts packages/core/test/smoke.test.ts packages/core/package.json pnpm-lock.yaml
git commit -m "feat(core): runSmokeTest drives one real tool call through the production proxy

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 9 [Group D]: `parseInitFlags` and the exit-code table

**Files:**
- Create: `apps/cli/src/flags.ts`
- Test: `apps/cli/test/flags.test.ts`

**Interfaces:**
- Consumes: nothing. `node:path`'s `resolve` only.
- Produces:

```ts
export type ExitCode = 0 | 1 | 2 | 3 | 4 | 5 | 130;
export type InitFlags = {
  yes: boolean;
  url?: string;
  model?: string;
  dir?: string;        // already resolved to an absolute path
  force: boolean;
  smoke: boolean;      // false when --no-smoke
};
export type FlagResult =
  | { ok: true; flags: InitFlags }
  | { ok: false; message: string };   // message is the full usage error
export function parseInitFlags(argv: readonly string[]): FlagResult;
```

Steps:

- [ ] Create `apps/cli/test/flags.test.ts`:

```ts
import { isAbsolute } from "node:path";
import { describe, expect, it } from "vitest";
import { parseInitFlags } from "../src/flags.js";

const ok = (argv: string[]) => {
  const r = parseInitFlags(argv);
  if (!r.ok) throw new Error(`expected ok, got: ${r.message}`);
  return r.flags;
};
const err = (argv: string[]): string => {
  const r = parseInitFlags(argv);
  if (r.ok) throw new Error("expected a usage error");
  return r.message;
};

describe("init flag parsing", () => {
  it("defaults to a fully non-interactive run with the smoke test on", () => {
    const f = ok([]);
    expect(f).toEqual({ yes: false, url: undefined, model: undefined, dir: undefined,
      force: false, smoke: true });
  });
  it("reads the four documented flags", () => {
    const f = ok(["--yes", "--url", "http://127.0.0.1:9000", "--model", "m-a", "--force"]);
    expect(f.yes).toBe(true);
    expect(f.url).toBe("http://127.0.0.1:9000");
    expect(f.model).toBe("m-a");
    expect(f.force).toBe(true);
  });
  it("--no-smoke turns the tool-call check off", () => {
    expect(ok(["--no-smoke"]).smoke).toBe(false);
  });
  it("resolves --dir to an absolute path, so a relative one cannot surprise anyone", () => {
    const f = ok(["--dir", "sub/project"]);
    expect(f.dir !== undefined && isAbsolute(f.dir)).toBe(true);
  });
  it("rejects an unknown flag by name, and lists the real ones", () => {
    const m = err(["--nope"]);
    expect(m).toContain("--nope");
    expect(m).toContain("--yes");
    expect(m).toContain("--url");
    expect(m).toContain("--model");
    expect(m).toContain("--dir");
    expect(m).toContain("--force");
    expect(m).toContain("--no-smoke");
  });
  it("rejects a value flag with nothing after it", () => {
    expect(err(["--url"])).toContain("--url");
    expect(err(["--model"])).toContain("--model");
  });
  it("rejects a --url that is not a URL, and a non-http scheme", () => {
    expect(err(["--url", "not a url"])).toContain("--url");
    expect(err(["--url", "file:///etc/passwd"])).toContain("--url");
  });
  it("accepts a non-loopback --url: the operator asked for it explicitly", () => {
    expect(ok(["--url", "http://example.invalid:8080"]).url)
      .toBe("http://example.invalid:8080");
  });
});
```

- [ ] Run `pnpm test -- flags`. Expected: FAIL - `../src/flags.js` does not exist.
- [ ] Create `apps/cli/src/flags.ts` with exactly:

```ts
import { resolve } from "node:path";

export type ExitCode = 0 | 1 | 2 | 3 | 4 | 5 | 130;

export type InitFlags = {
  yes: boolean;
  url?: string;
  model?: string;
  dir?: string;
  force: boolean;
  smoke: boolean;
};

export type FlagResult =
  | { ok: true; flags: InitFlags }
  | { ok: false; message: string };

const VALUE_FLAGS: Record<string, "url" | "model" | "dir"> = {
  "--url": "url", "--model": "model", "--dir": "dir",
};
const BOOL_FLAGS: Record<string, "yes" | "force" | "no-smoke"> = {
  "--yes": "yes", "--force": "force", "--no-smoke": "no-smoke",
};

const USAGE = "usage: tinystrap init [--yes] [--url <server-url>] [--model <id>] "
  + "[--dir <project-dir>] [--force] [--no-smoke]";

function usage(problem: string): string { return `${problem}\n${USAGE}`; }

export function parseInitFlags(argv: readonly string[]): FlagResult {
  const flags: InitFlags = { yes: false, force: false, smoke: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const valueFlag = VALUE_FLAGS[arg];
    if (valueFlag !== undefined) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { ok: false, message: usage(`${arg} needs a value.`) };
      }
      i += 1;
      if (valueFlag === "dir") {
        // Resolved here so every later path operation is absolute (Windows-safe:
        // resolve() uses the platform separator, never a hand-built one).
        flags.dir = resolve(value);
      } else if (valueFlag === "url") {
        let parsed: URL;
        try { parsed = new URL(value); } catch {
          return { ok: false, message: usage(`--url is not a valid URL: ${value}`) };
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return { ok: false, message: usage(
            `--url must be http or https, got ${parsed.protocol}`) };
        }
        // A non-loopback URL is allowed on purpose: the operator typed it. Discovery
        // never picks one by itself (local.ts probes loopback only).
        flags.url = value;
      } else {
        flags.model = value;
      }
      continue;
    }
    const boolFlag = BOOL_FLAGS[arg];
    if (boolFlag !== undefined) {
      if (boolFlag === "yes") flags.yes = true;
      else if (boolFlag === "force") flags.force = true;
      else flags.smoke = false;
      continue;
    }
    if (arg.startsWith("-")) return { ok: false, message: usage(`unknown flag: ${arg}`) };
    return { ok: false, message: usage(`unexpected argument: ${arg}`) };
  }
  return { ok: true, flags };
}
```

- [ ] Run `pnpm test -- flags` + `pnpm typecheck`. Expected: PASS.
- [ ] Commit:

```bash
git add apps/cli/src/flags.ts apps/cli/test/flags.test.ts
git commit -m "feat(cli): parseInitFlags with usage errors for the init command

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 10 [Group D]: `renderHostInstructions` — print the host setup, edit nothing

**Files:**
- Create: `packages/core/src/instructions.ts`
- Modify: `packages/core/src/index.ts` (one additive export line)
- Test: `packages/core/test/instructions.test.ts`

**Interfaces:**
- Consumes: `buildOpenCodeConfig`'s output shape (`adapters/opencode/src/config.ts:1-8`) and the env-var endpoint `PiRunner` sets (`adapters/pi/src/runner.ts:37`). The shape is **inlined as data**, not imported: `core` must not gain a dependency on an adapter.
- Produces:

```ts
export const DEFAULT_PROXY_BASE_URL: string;   // "http://127.0.0.1:8787"
export function renderHostInstructions(opts: {
  model: string;
  proxyBaseUrl?: string;
  configPath: string;
}): string;
```

Steps:

- [ ] Create `packages/core/test/instructions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_PROXY_BASE_URL, renderHostInstructions } from "@tinystrap/core";

describe("host setup instructions", () => {
  const text = renderHostInstructions({
    model: "m-a", configPath: "/w/project/tinystrap.toml",
  });

  it("prints an OpenCode provider block matching the adapter's own shape", () => {
    // adapters/opencode/src/config.ts:10 builds exactly this: one provider named
    // tinystrap, npm @ai-sdk/openai-compatible, baseURL <proxy>/v1, apiKey tinystrap.
    expect(text).toContain("@ai-sdk/openai-compatible");
    expect(text).toContain(DEFAULT_PROXY_BASE_URL + "/v1");
    expect(text).toContain('"m-a"');
    expect(text).toContain("provider");
  });
  it("prints the pi endpoint as the env var PiRunner actually sets", () => {
    // adapters/pi/src/runner.ts:37 sets OPENAI_BASE_URL; the comment above it
    // marks the mechanism UNVERIFIED, so the text must not claim it is confirmed.
    expect(text).toContain("OPENAI_BASE_URL");
    expect(text).toContain("unverified");
  });
  it("never claims to have written a host config", () => {
    expect(text.toLowerCase()).toContain("does not edit");
    expect(text).toContain("/w/project/tinystrap.toml");
  });
  it("honours an explicit proxy URL", () => {
    const t = renderHostInstructions({ model: "m-a", proxyBaseUrl: "http://127.0.0.1:9000",
      configPath: "/w/project/tinystrap.toml" });
    expect(t).toContain("http://127.0.0.1:9000/v1");
  });
});
```

- [ ] Run `pnpm test -- instructions`. Expected: FAIL - `renderHostInstructions` is not exported.
- [ ] Create `packages/core/src/instructions.ts` with exactly:

```ts
// The proxy URL a host should point at. `init` starts a proxy only long enough to
// smoke-test it and then closes it, so the instructions must name a stable URL -
// this is the port the harness documents for host runs. No command on main starts
// a proxy on this port yet; that is a known gap, reported with this plan.
export const DEFAULT_PROXY_BASE_URL = "http://127.0.0.1:8787";

export function renderHostInstructions(opts: {
  model: string;
  proxyBaseUrl?: string;
  configPath: string;
}): string {
  const base = (opts.proxyBaseUrl ?? DEFAULT_PROXY_BASE_URL).replace(/\/+$/, "");
  // Same shape buildOpenCodeConfig produces (adapters/opencode/src/config.ts), so
  // what the operator pastes in is exactly what the adapter would have written.
  const openCode = JSON.stringify({
    provider: {
      tinystrap: {
        npm: "@ai-sdk/openai-compatible",
        name: "tinystrap proxy",
        options: { baseURL: `${base}/v1`, apiKey: "tinystrap" },
        models: { [opts.model]: {} },
      },
    },
  }, null, 2);
  return [
    "",
    "Next: point your coding host at the tinystrap proxy.",
    "",
    `Config written: ${opts.configPath}`,
    "tinystrap init does not edit any host configuration - nothing outside your",
    "project was created or changed. Paste the snippets below yourself.",
    "",
    "OpenCode - merge this into your OpenCode provider config:",
    "",
    openCode,
    "",
    "pi - pi is started with its endpoint in the environment (see",
    "adapters/pi/src/runner.ts); whether pi reads this variable, a config file,",
    "or a flag is unverified, so check your pi version:",
    "",
    `  OPENAI_BASE_URL=${base}/v1`,
    "",
    `Then start the proxy on ${base} and use the model id "${opts.model}".`,
    "",
  ].join("\n");
}
```

- [ ] Add `export * from "./instructions.js";` to `packages/core/src/index.ts`.
- [ ] Run `pnpm test -- instructions` + `pnpm typecheck`. Expected: PASS. The rendered JSON is asserted structurally, not string-compared, so key order cannot make it flaky.
- [ ] Commit:

```bash
git add packages/core/src/instructions.ts packages/core/src/index.ts packages/core/test/instructions.test.ts
git commit -m "feat(core): print OpenCode and pi setup instructions without touching host configs

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 11 [Group D]: `runInit` orchestration and the `init` dispatch

**Files:**
- Create: `apps/cli/src/init.ts`
- Modify: `apps/cli/src/main.ts` (one branch, one exit-code path)
- Test: `apps/cli/test/init.test.ts`
- Modify: `apps/cli/package.json` (add `@tinystrap/proxy` as a runtime dependency)
- Modify: `apps/cli/tsconfig.json` (add the proxy project reference)

**Interfaces:**
- Consumes: everything from groups A-C — `LocalDiscovery`, `describeAttempts`, `isLoopbackUrl`, `writeInitConfig`, `ConfigExistsError`, `pickServer`, `pickModel`, `summarizeChoice`, `runDoctor`, `runSmokeTest`, `renderHostInstructions`; plus `startProxy` / `HttpProvider` from `@tinystrap/proxy` and `createToolRegistry` from `@tinystrap/policy`.
- Produces:

```ts
export type InitDeps = {
  io: PromptIO;                       // required: the caller owns the terminal
  discovery?: Discovery;              // tests inject StubDiscovery
  startProxy?: typeof startProxy;     // default: the real startProxy
  provider?: (baseUrl: string) => Provider;  // default: new HttpProvider({ baseUrl })
  resolveProfile?: (model: string) => string | undefined;
  instructions?: typeof renderHostInstructions;
};
export async function runInit(argv: readonly string[], deps: InitDeps):
  Promise<{ code: ExitCode; output: string }>;
```

Steps:

- [ ] In `apps/cli/package.json` add `"@tinystrap/proxy": "workspace:*"` to `dependencies`, run `pnpm install`, and add `{"path": "../../packages/proxy"}` to the `references` array in `apps/cli/tsconfig.json`. Commit the `pnpm-lock.yaml` change in the same commit as the manifest. This is the **app layer** legitimately depending on the proxy (the CLI is what starts one); `core` still must not.
- [ ] Create `apps/cli/test/init.test.ts`:

```ts
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/init.js";
import { StubDiscovery } from "@tinystrap/discovery";
import type { PromptIO } from "@tinystrap/core";
import type { DiscoveredValues } from "@tinystrap/discovery";

type Term = PromptIO & { output: string };

function io(answers: string[] = []): Term {
  const lines: string[] = [];
  const queue = [...answers];
  return {
    isTty: true,
    out: (l) => { lines.push(l); },
    err: (l) => { lines.push(l); },
    ask: async () => queue.shift() ?? "",
    get output() { return lines.join("\n"); },
  };
}

const found: DiscoveredValues = {
  servers: [{ baseUrl: "http://127.0.0.1:8080", kind: "llamacpp",
    models: [{ id: "m-a", contextLength: 8192 }] }],
  selectedModel: "m-a", contextLength: 8192,
  attempts: [{ url: "http://127.0.0.1:8080/props", outcome: "ok", status: 200 }],
  probeSource: "loopback",
};
const project = (): string => mkdtempSync(join(tmpdir(), "ts-init-e2e-"));

// startProxy/provider are injected: the e2e test must never open a socket.
const neverStarted = (..._args: never[]): never => {
  throw new Error("the test must not start a proxy");
};
const smokeOk = async (): Promise<{ ok: boolean; toolCalls: number; detail: string }> =>
  ({ ok: true, toolCalls: 1, detail: "ok" });
const baseDeps = (term: PromptIO) => ({
  io: term, discovery: new StubDiscovery(found),
  startProxy: neverStarted, provider: neverStarted, smoke: smokeOk,
});

describe("tinystrap init", () => {
  it("writes one config, reports doctor, smokes, and prints host instructions", async () => {
    const dir = project();
    const r = await runInit(["--dir", dir], baseDeps(io()));
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, "tinystrap.toml"))).toBe(true);
    expect(readFileSync(join(dir, "tinystrap.toml"), "utf8")).toContain('model = "m-a"');
    expect(r.output).toContain("tinystrap doctor");
    expect(r.output).toContain("@ai-sdk/openai-compatible");
  });
  it("writes exactly one file into the project", async () => {
    const dir = project();
    await runInit(["--dir", dir], baseDeps(io()));
    expect(readdirSync(dir)).toEqual(["tinystrap.toml"]);
  });
  it("refuses an existing config, changes nothing, and exits 4", async () => {
    const dir = project();
    const deps = baseDeps(io());
    expect((await runInit(["--dir", dir], deps)).code).toBe(0);
    const before = readFileSync(join(dir, "tinystrap.toml"), "utf8");
    const second = await runInit(["--dir", dir], deps);
    expect(second.code).toBe(4);
    expect(second.output).toContain("never overwrites it");
    expect(readFileSync(join(dir, "tinystrap.toml"), "utf8")).toBe(before);
  });
  it("--force replaces it and exits 0", async () => {
    const dir = project();
    const deps = baseDeps(io());
    await runInit(["--dir", dir], deps);
    expect((await runInit(["--dir", dir, "--force"], deps)).code).toBe(0);
  });
  it("exits 3 and names every endpoint when nothing answers", async () => {
    const r = await runInit(["--dir", project()], {
      io: io(), discovery: new StubDiscovery({
        servers: [],
        attempts: [
          { url: "http://127.0.0.1:8080/props", outcome: "unreachable", detail: "ECONNREFUSED" },
          { url: "http://127.0.0.1:1234/v1/models", outcome: "unreachable", detail: "ECONNREFUSED" },
        ],
        probeSource: "loopback",
      }),
    });
    expect(r.code).toBe(3);
    expect(r.output).toContain("no model server answered");
    expect(r.output).toContain("http://127.0.0.1:8080/props");
    expect(r.output).toContain("http://127.0.0.1:1234/v1/models");
  });
  it("exits 5 when the model answers without calling a tool", async () => {
    const dir = project();
    const r = await runInit(["--dir", dir], {
      io: io(), discovery: new StubDiscovery(found),
      startProxy: neverStarted, provider: neverStarted,
      smoke: async () => ({ ok: false, toolCalls: 0,
        detail: "the model answered without calling the tool" }),
    });
    expect(r.code).toBe(5);
    expect(r.output).toContain("smoke test failed");
  });
  it("--no-smoke skips the proxy entirely and exits 0", async () => {
    const dir = project();
    const r = await runInit(["--dir", dir, "--no-smoke"], {
      io: io(), discovery: new StubDiscovery(found),
      startProxy: neverStarted, provider: neverStarted,
    });
    expect(r.code).toBe(0);
  });
  it("--model the server does not serve exits 2 with the list of what it does", async () => {
    const dir = project();
    const r = await runInit(["--dir", dir, "--model", "nope"], {
      io: io(), discovery: new StubDiscovery(found),
      startProxy: neverStarted, provider: neverStarted,
    });
    expect(r.code).toBe(2);
    expect(r.output).toContain("is not served by");
    expect(r.output).toContain("m-a");
  });
  it("an interactive answer is required unless --yes", async () => {
    const dir = project();
    const term = io();
    term.isTty = false;
    const r = await runInit(["--dir", dir], {
      io: term, discovery: new StubDiscovery(found),
      startProxy: neverStarted, provider: neverStarted,
    });
    expect(r.code).toBe(2);
    expect(r.output).toContain("--yes");
  });
  it("--yes proceeds without a terminal", async () => {
    const dir = project();
    const term = io();
    term.isTty = false;
    expect((await runInit(["--dir", dir, "--yes"], {
      io: term, discovery: new StubDiscovery(found),
      startProxy: neverStarted, provider: neverStarted, smoke: smokeOk,
    })).code).toBe(0);
  });
});
```

- [ ] Run `pnpm test -- init`. Expected: FAIL - `../src/init.js` does not exist.
- [ ] Add `smoke?: typeof runSmokeTest;` to `InitDeps` and create `apps/cli/src/init.ts` with exactly:

```ts
import { join } from "node:path";
import {
  ConfigExistsError, pickModel, pickServer, renderHostInstructions, runDoctor,
  runSmokeTest, summarizeChoice, writeInitConfig,
} from "@tinystrap/core";
import type { InitTomlValues, PromptIO } from "@tinystrap/core";
import { LocalDiscovery, describeAttempts } from "@tinystrap/discovery";
import type { Discovery } from "@tinystrap/discovery";
import { startProxy as realStartProxy, HttpProvider } from "@tinystrap/proxy";
import type { Provider } from "@tinystrap/proxy";
import { createToolRegistry } from "@tinystrap/policy";
import { parseInitFlags, type ExitCode } from "./flags.js";

export type InitDeps = {
  io: PromptIO;
  discovery?: Discovery;
  startProxy?: typeof realStartProxy;
  provider?: (baseUrl: string) => Provider;
  resolveProfile?: (modelId: string) => string | undefined;
  smoke?: typeof runSmokeTest;
  instructions?: typeof renderHostInstructions;
};

type Outcome = { code: ExitCode; output: string };

export async function runInit(argv: readonly string[], deps: InitDeps): Promise<Outcome> {
  const lines: string[] = [];
  const say = (l: string): void => { lines.push(l); deps.io.out(l); };

  const parsed = parseInitFlags(argv);
  if (!parsed.ok) return { code: 2, output: parsed.message };
  const flags = parsed.flags;
  const dir = flags.dir ?? process.cwd();

  // --url is the ONLY way a non-loopback address is ever probed; otherwise the
  // fixed loopback sweep runs. LocalDiscovery derives probeSource from its targets,
  // so the report stays honest either way.
  const discovery = deps.discovery
    ?? new LocalDiscovery(flags.url !== undefined ? { targets: [flags.url] } : {});

  let discovered;
  try {
    discovered = await discovery.probe();
  } catch (err) {
    return { code: 1, output: `discovery failed: ${(err as Error).message}` };
  }

  if (discovered.servers.length === 0) {
    const attempts = discovered.attempts ?? [];
    // Spec section 14: say exactly what was probed and what came back.
    return { code: 3, output:
      "no model server answered. "
      + `${describeAttempts(attempts)}. `
      + "Start your model server, or re-run with --url <server-url>." };
  }

  // Confirmation needs a terminal, unless the operator has already said yes.
  if (!flags.yes && !deps.io.isTty) {
    return { code: 2, output:
      "tinystrap init needs a terminal to confirm the model. "
      + "Re-run with --yes to accept what was discovered, or pass --model and --url." };
  }

  const server = await pickServer(deps.io, discovered.servers);
  if (server === null) return { code: 2, output: "no server chosen; nothing was written." };

  const model = await pickModel(deps.io, server, flags.model);
  if (model === null) return { code: 2, output: "no model chosen; nothing was written." };

  const found = server.models.find((m) => m.id === model);
  const contextLength = found?.contextLength;
  summarizeChoice(deps.io, server, model, contextLength);

  const values: InitTomlValues = {
    baseUrl: server.baseUrl, model, kind: server.kind, contextLength,
  };
  let path: string;
  try {
    path = writeInitConfig({ projectRoot: dir, values, force: flags.force }).path;
  } catch (err) {
    if (err instanceof ConfigExistsError) return { code: 4, output: err.message };
    return { code: 1, output: `could not write ${join(dir, "tinystrap.toml")}: `
      + `${(err as Error).message}` };
  }
  say(`wrote ${path}`);

  // The config now exists, so doctor resolves from it, not from discovery alone.
  say("");
  say(await runDoctor(dir, discovery, undefined,
    deps.resolveProfile !== undefined ? { resolveProfile: deps.resolveProfile } : undefined));

  if (flags.smoke) {
    say("");
    const start = deps.startProxy ?? realStartProxy;
    const makeProvider = deps.provider ?? ((baseUrl: string) => new HttpProvider({ baseUrl }));
    // The smoke proxy has no task workspace, so it runs with an allow-all
    // preflight and guidance off: this checks the tool-call path end to end, not
    // the policy engine, which `tinystrap doctor` is for.
    const proxy = await start({
      provider: makeProvider(server.baseUrl),
      registry: createToolRegistry(),
      preflight: () => ({ effect: "allow" as const }),
      features: { guidance: false },
      taskId: "init-smoke",
    });
    const smoke = deps.smoke ?? runSmokeTest;
    let result;
    try {
      result = await smoke({ proxyBaseUrl: proxy.url, model });
    } finally {
      await proxy.close();
    }
    if (!result.ok) {
      return { code: 5, output:
        `smoke test failed: ${result.detail} `
        + "The config was written; see the setup notes below." };
    }
    say(`smoke test ok: ${result.detail}`);
  }

  const render = deps.instructions ?? renderHostInstructions;
  const instructions = render({ model, configPath: path });
  deps.io.out(instructions);
  lines.push(instructions);
  return { code: 0, output: lines.join("\n") };
}
```

  Drop `type PromptOnly_unused` from the first import list - it is a marker for a name that does not exist; the real type is `PromptIO`, imported on the next line. Also drop the unused `existsSync` and `isLoopbackUrl` imports.
- [ ] Add the `init` branch to `apps/cli/src/main.ts`, immediately after the existing `doctor` branch, without touching any other branch. Declare the exit-code carrier at **module scope** (above `runCli`), because the branch writes it and the entry block reads it:

```ts
// Set by the `init` branch only. `init` is the one command with an exit-code
// contract (see flags.ts); every other branch keeps today's string return and the
// existing throw-to-exit-1 behavior.
let initExitCode: number | undefined;
```

```ts
  if (argv[0] === "init") {
    const { code, output } = await runInit(argv.slice(1), {
      io: {
        out: (l) => process.stdout.write(l + "\n"),
        err: (l) => process.stderr.write(l + "\n"),
        ask: (q) => askOnTerminal(q),
        isTty: Boolean(process.stdin.isTTY),
      },
    });
    initExitCode = code;
    return output;
  }
```

  and change the entry block at the bottom to propagate it:

```ts
const isEntry = process.argv[1]?.replace(/\\/g, "/").includes("apps/cli/src/main");
if (isEntry) {
  runCli(process.argv.slice(2)).then(
    (out) => {
      console.log(out);
      if (initExitCode !== undefined) process.exitCode = initExitCode;
    },
    (err) => { console.error(String(err.message ?? err)); process.exitCode = 1; },
  );
}
```

  plus the two imports and helper the branch needs, at the top of the file:

```ts
import { createInterface } from "node:readline/promises";
import { runInit } from "./init.js";

// The ONLY place this repo reads a terminal. Used by the entry path in main.ts
// alone - `core` takes an injected PromptIO, and no test ever calls this.
async function askOnTerminal(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(question)).trim(); } finally { rl.close(); }
}
```

- [ ] Run `pnpm test -- init` + `pnpm test` + `pnpm typecheck`. Expected: PASS. `apps/cli/test/cli.test.ts` still passes unchanged - the `doctor`, `task new`, and `task export` branches and the `unknown command` throw are all untouched. No test opens a socket: `startProxy` and `provider` are injected and the smoke check is injected, and the one test that must not start a proxy passes `neverStarted`.
- [ ] Commit:

```bash
git add apps/cli/src/init.ts apps/cli/src/main.ts apps/cli/test/init.test.ts apps/cli/package.json apps/cli/tsconfig.json pnpm-lock.yaml
git commit -m "feat(cli): tinystrap init discovers, confirms, writes, verifies, and prints host setup

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 12 [Group D]: the operator-run live smoke path (never CI)

**Files:**
- Create: `scripts/live-init-smoke.mjs`

**Interfaces:**
- Consumes: `startProxy` + `HttpProvider` + `FakeProvider`-free real upstream, `runSmokeTest` and `LocalDiscovery` — all from each package's **built `dist/`**, exactly as `scripts/live-host-check-opencode.mjs:18-21` does (`--conditions=tinystrap-dist`).
- Produces: an operator script, not a library. No export, no test.

Steps:

- [ ] Create `scripts/live-init-smoke.mjs`:

```js
// Operator-gated: runs the init smoke path against a REAL local model server the
// operator already started. This is the only code in the plan that talks to a real
// server; `pnpm test` must never run it.
//
// Usage (after `pnpm typecheck` to build dist/):
//   node --conditions=tinystrap-dist scripts/live-init-smoke.mjs --url http://127.0.0.1:8080 --model <id>
//
// scripts/ is not a workspace member, so bare @tinystrap/* specifiers have no
// node_modules to resolve from here; the relative dist/ imports below are required
// for the same reason as in live-host-check-opencode.mjs.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProxy, HttpProvider } from "../packages/proxy/dist/index.js";
import { createToolRegistry } from "../packages/policy/dist/index.js";
import { runSmokeTest, writeInitConfig, runDoctor } from "../packages/core/dist/index.js";
import { LocalDiscovery, describeAttempts } from "../packages/discovery/dist/index.js";

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const url = flag("--url");
const model = flag("--model");
if (!url || !model) {
  console.error("usage: live-init-smoke.mjs --url <server-url> --model <id>");
  process.exit(2);
}
try { new URL(url); } catch {
  console.error(`invalid --url: ${url}`);
  process.exit(2);
}

// 1. Discovery, exactly as init would run it.
const discovered = await new LocalDiscovery({ targets: [url] }).probe();
if (discovered.servers.length === 0) {
  console.error("discovery found nothing. " + describeAttempts(discovered.attempts ?? []));
  process.exit(3);
}
console.log("discovered:", JSON.stringify(discovered.servers, null, 2));
if (!discovered.servers[0].models.some((m) => m.id === model)) {
  console.error(`the server does not serve ${model}; it serves `
    + discovered.servers[0].models.map((m) => m.id).join(", "));
  process.exit(2);
}

// 2. The config write, into a scratch directory - never into the operator's project.
const projectRoot = mkdtempSync(join(tmpdir(), "live-init-"));
const { path } = writeInitConfig({
  projectRoot,
  values: { baseUrl: url, model, kind: discovered.servers[0].kind,
    contextLength: discovered.contextLength },
});
console.log("wrote " + path);
console.log(await runDoctor(projectRoot, new LocalDiscovery({ targets: [url] })));

// 3. The smoke test, through a real proxy in front of the real server.
const proxy = await startProxy({
  provider: new HttpProvider({ baseUrl: url }),
  registry: createToolRegistry(),
  preflight: () => ({ effect: "allow" }),
  features: { guidance: false },
  taskId: "live-init-smoke",
});
let result;
try { result = await runSmokeTest({ proxyBaseUrl: proxy.url, model }); }
finally { await proxy.close(); }
console.log("config:"); console.log(readFileSync(path, "utf8"));
console.log("smoke:", result);
process.exit(result.ok ? 0 : 5);
```

- [ ] Run `node --check scripts/live-init-smoke.mjs`. Expected: OK (syntax only; the script is never executed by CI).
- [ ] Run `node --conditions=tinystrap-dist scripts/live-init-smoke.mjs` with **no** flags. Expected: FAIL with exit code 2 and the usage line — this is the script's own guard, and it returns before opening a socket, so it is safe to run in any environment. It is the only execution of this file that CI may ever do.
- [ ] Run `pnpm test` + `pnpm typecheck`. Expected: PASS, and no test collects this file — it matches no `*.test.ts` pattern and lives outside every package's `test/` directory.
- [ ] Commit:

```bash
git add scripts/live-init-smoke.mjs
git commit -m "chore(scripts): operator-run live smoke check for the init path

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

## Self-review

Run this before opening the PR. It is a checklist against the brief, not a code review.

**Requirements coverage**

- [ ] Zero-input discovery where possible: `LocalDiscovery` (Tasks 1-3) sweeps a fixed loopback port list with no user input; `--yes` + `--url` cover the rest (Task 9).
- [ ] Confirms model, context length, and profile: `pickModel` / `summarizeChoice` (Task 7), with the profile surfaced by the injected `resolveProfile` seam in doctor (Task 6) and supplied by the CLI in Task 11.
- [ ] Writes a single `tinystrap.toml` and no other config file: `renderInitToml` / `writeInitConfig` (Tasks 4-5); asserted by the "writes exactly one file into the project" case in Task 11.
- [ ] Runs doctor plus a tool-call smoke test through the **real** proxy: `runDoctor` (Task 6) and `runSmokeTest` (Task 8), with `startProxy` used unmodified in both the unit test and the orchestrator.
- [ ] Prints host setup instructions without editing host configs: `renderHostInstructions` (Task 10), asserted on the "does not edit" wording and the absence of any write in `runInit`.
- [ ] Probes only localhost or a user-given URL: `localTargets` probes loopback only; `--url` is the sole non-loopback path and the parser accepts it only as an explicit operator input (Tasks 1, 9).
- [ ] Non-interactive flags `--yes`, `--url`, `--model`, `--dir`: Task 9, with the two additions `--force` and `--no-smoke` named in the usage text.
- [ ] Prompt UI testable with injected IO, no real TTY: `PromptIO` (Task 7); `main.ts`'s `askOnTerminal` is reachable only from the entry block and is never imported by a test.
- [ ] Unit smoke test uses a scripted `FakeProvider`; the live path is operator-only: Task 8 (FakeProvider) and Task 12 (a script no CI job runs).
- [ ] Tests never touch the network or a real host binary: every discovery test injects a `fetch` double; the only sockets are loopback to a proxy the test starts; Task 12 is `node --check` only.
- [ ] Config schema and writer: idempotent (Task 5 asserts a second `init` without `--force` changes nothing), never clobbers without `--force`, and the comment-preservation limitation of `smol-toml` is stated in *Dependency choice* and avoided by construction.
- [ ] Dependency choice: the library is named, its presence in `pnpm-lock.yaml` is cited by line, and the rejection of alternatives is argued — see *Dependency choice*.
- [ ] Exit codes: a dedicated table plus one assertion per code in Task 11.
- [ ] Actionable error messages: a dedicated table; each of its strings is asserted verbatim in Tasks 2, 5, 7, or 11.
- [ ] Windows path handling: a dedicated section; the space-in-path case is asserted in Task 5, `resolve()` is asserted in Task 9.

**Structural checks**

- [ ] Every task has Files, Interfaces (Consumes/Produces with exact signatures), checkbox steps, real test code, an expected failure, a minimal implementation, an expected pass, and an exact commit command.
- [ ] Every code block type-checks as written: no placeholder identifiers, no `require` in an ESM file, no unused imports, no unreachable code.
- [ ] No task is longer than about five minutes of work.
- [ ] No new third-party dependency; the only manifest changes are two workspace-internal `workspace:*` links plus their `pnpm-lock.yaml` updates.
- [ ] No IP addresses, hostnames, usernames, or local paths; no operator LAN address.
- [ ] Merge order A, B, C, D is respected, and the one shared file (`packages/core/src/index.ts`) is appended to in that order.

**Final verification**

```bash
pnpm test
pnpm typecheck
node --check scripts/live-init-smoke.mjs
git status --short
```

Expected: all green; `git status` shows only the files this plan creates or modifies.

## Open questions for the user

1. **`init` starts a proxy only to smoke-test it, then closes it** — but the OpenCode snippet it prints needs a *stable* proxy URL. This plan names `http://127.0.0.1:8787` and documents the gap, because no command on `main` yet starts a proxy on a fixed port (the supervisor plan owns that). Confirm the port, or accept it as provisional.
2. **`--force` and `--no-smoke` are additions** beyond the four flags in the brief. `--force` is required by the never-clobber rule; `--no-smoke` is the escape hatch for an operator whose model cannot do tool calls and who does not want exit code 5. Confirm both are wanted.
3. **Ambiguous responders are labelled `openai-compatible`**, not `ollama` / `lmstudio`, because spec §8 marks those two rows "to verify". If a user runs Ollama, `init` will work but the reported server kind will be generic. Accept, or should this plan attempt live identification?
4. **The smoke proxy runs with an allow-all preflight and guidance disabled.** It verifies the tool-call path, not the policy engine. A stricter smoke (real `evaluate` against a scratch workspace) is possible but needs a workspace, which `init` does not create. Accept?
5. **Per the brief's own precedent** (the dialect plan, which names an unverified "later plan" for `[host]` wiring), `[workspace]` from spec §7, the user-level defaults file, and the rest of doctor's §8.1 rows are explicitly out of scope here and listed under Global Constraints. Confirm the deferral list.
