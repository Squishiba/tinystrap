# Host Runner and OpenCode Adapter Implementation Plan (delivery step 4)

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Build the thin host layer (spec §6, §13.3): a `HostRunner` contract that the supervisor uses to run *any* coding-agent runtime headlessly against a tinystrap task workspace, plus the first concrete adapter — **OpenCode** — that spawns `opencode run` headless with its model endpoint pointed at the tinystrap proxy (`packages/proxy`), parses the host's JSON event stream into the shared `HarnessEvent` model, writes a transcript file, and enforces timeout/cancellation. A second, smaller `PiRunner` implements the same contract for `pi -p --mode json`. An operator-gated live-check script runs one trivial task against a real local model server; automated tests never contact a model server.

**Architecture:** One shared interface in `@tinystrap/core` (`hostrunner.ts`) — the spec's package table (§6) names `adapters/opencode` and `adapters/pi` but does **not** name a home for the host-runner abstraction; it lives in core because core owns the task lifecycle (`TaskHandle`, `extractPatch`) and the spec's dependency rule already points adapters at core types. A new package for one interface would be premature (YAGNI). Each adapter package depends on `@tinystrap/core` (types) and `@tinystrap/policy` (event kinds) only — never the reverse. The OpenCode adapter is three pure modules (provider-config builder, JSONL event parser, argv builder) plus one I/O module (`OpenCodeRunner`) that spawns the process; the pure modules carry the tests, and the runner is tested against a **fake host executable** (a Node script that prints recorded JSONL and exits) so no model, no network, and no opencode install is required in CI. Policy enforcement stays in the proxy's preflight gate (spec §10.1) — the adapter's optional tool-blocking plugin is defense-in-depth and **feasibility-gated** (Appendix A7): if the installed opencode's plugin API cannot block a tool call, the plugin task stops there and the rest of the plan is unaffected.

**Tech Stack:** Node.js 20+ (`node:child_process`, built-ins only — zero new runtime dependencies), TypeScript 5 strict ESM (NodeNext), pnpm workspaces, vitest. Same toolchain as the prior plans. Verified host facts (from the task brief, against installed opencode 1.18.x): `opencode run` supports `--dir <path>`, `--model <provider/model>`, `--format json` (JSONL event stream on stdout), `--pure` (skip external plugin fetch), `--auto` (auto-approve permissions).

**Spec:** `docs/superpowers/specs/2026-09-20-tinystrap-harness-design.md` (§6 host/adapter layout, §10.1 single enforcement point, §13.3 shared event model, §13.4 event kinds, §16 step 4, Appendix A7). Prior plans: `2026-09-20-core-m1-m2.md` (core), `2026-09-21-proxy-and-small-model-layer.md` (proxy). The `docs/deployment-modes` additions (PR #4: `WorkspaceProvider`, `open_pr` mode) are **out of scope here** and ignored.

## Global Constraints

Copied from the spec (and the task brief); these bind every task:

- The host layer is **thin**: it spawns a real coding-agent runtime; it does not reimplement one. No agent loop, no tool execution of our own in the adapter.
- The proxy remains the **single enforcement point** (spec §10.1). The adapter points the host's model endpoint at the proxy; it adds no policy decisions of its own. The OpenCode plugin (Task 7) is optional defense-in-depth, feasibility-gated per Appendix A7 — if it cannot be verified against the installed opencode 1.18.x, stop that task and record the finding; nothing else may depend on it.
- The model endpoint is **always** the proxy URL passed in (`http://127.0.0.1:<port>` from `startProxy()`'s return) — never a hardcoded port, never the upstream model server directly.
- Hosts run **headless**: `opencode run --format json` (non-interactive), `pi -p --mode json`. No TTY assumptions.
- Every run produces a **transcript file** (raw host output, JSONL) under the task's `logsDir`, and normalized `HarnessEvent`s (spec §13.3/§13.4). No secrets or full sensitive arguments in events — digests and redacted summaries only (spec §13.4).
- **Timeout and cancellation are mandatory** on the contract: `HostRunner.run(task, signal?)` accepts an `AbortSignal`; on trip the host process is killed and the result reports `timedOut`/`cancelled` — the run never hangs the supervisor.
- Automated tests **never contact a model server or the network**: host behavior is tested with a fake host executable; the live check (Task 9) is operator-gated, run manually against a local server the operator started, and is not wired into `pnpm test`.
- `HarnessEventKind` extension (Task 1) adds only kinds spec §13.4 names that `packages/policy/src/audit.ts` lacks today; existing kinds are untouched, existing tests must stay green.
- Explicitly deferred out of this plan: the supervisor CLI wiring (`tinystrap run` invoking a runner end-to-end), promotion/verifier (spec §9.9/§9.10), the bench harness (sibling plan `2026-09-22-bench-tier1.md`), the `pi` provider-config mechanism (marked to verify — the pi runner is scaffolded behind the same contract but its proxy-pointing mechanism is unverified).
- Shell commands in this plan use **only** the allowed set: `git`, `python`, `python -m pytest`, `pytest`, `ruff`, `pnpm`, `npm`, `mkdir`, `ao`, `node`, `tinystrap`, `refdes`. **Never** `rm`, `npx`, `cd`, `for`, or inline-assignment prefixes (`VAR=value cmd`) — refused by the shell whitelist; temp-dir cleanup in tests happens in Node code (`fs.rm`), not the shell.
- Windows/Git Bash: forward-slash-safe paths; all commands run from the repo root; spawned processes use argument arrays (never shell string interpolation).
- Strict TDD, DRY, YAGNI, one commit per task minimum; every commit message ends with the line `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.

## Interfaces consumed (verified against the code on `main`, 2026-09-22)

```ts
// @tinystrap/policy — packages/policy/src/audit.ts
export type HarnessEventKind =
  | "tool_request" | "tool_allowed" | "tool_denied" | "tool_asked"
  | "evasion_flagged" | "script_rescanned" | "task_created"
  | "baseline_captured" | "patch_extracted" | "patch_exported"
  | "tool_stream_started" | "tool_interrupted" | "reasoning_intervention";
export type HarnessEvent = {
  taskId: string; timestamp: string; kind: HarnessEventKind;
  tool?: string; argumentsDigest?: string; decision?: string;
  reason?: string; effectSignature?: string;
};
export function makeEvent(taskId: string, kind: HarnessEventKind,
  fields?: Partial<Omit<HarnessEvent, "taskId" | "kind" | "timestamp">>): HarnessEvent;

// @tinystrap/core — packages/core/src/taskstore.ts
export type TaskHandle = {
  taskId: string; taskDir: string; workspaceDir: string;
  baselinePath: string; patchPath: string; logsDir: string;
};
export async function createTask(projectRoot: string): Promise<TaskHandle>;
export async function destroyTask(handle: TaskHandle): Promise<void>;

// @tinystrap/proxy — packages/proxy/src/server.ts
export type ProxyDeps = {
  provider: Provider; registry: ToolRegistry;
  preflight: Preflight;                 // (tool, args) => PolicyDecision
  onEvent?: (e: HarnessEvent) => void;
};
export async function startProxy(deps: ProxyDeps, port = 0): Promise<{ url: string; close(): Promise<void> }>;
```

Spec §13.4 names event kinds the code does **not** have yet (`tool_executed`, `tool_failed`, `tool_call_repaired`, …). Task 1 adds the subset this plan emits; the bench plan adds `model_usage` on top.

## File Structure

| Path | Responsibility (single) |
| ---- | ----------------------- |
| `packages/policy/src/audit.ts` | (modify) add missing §13.4 kinds + `hostEvent` payload field |
| `packages/core/src/hostrunner.ts` | `HostTask` / `HostRunResult` / `HostRunner` contract (types only, zero imports) |
| `packages/core/src/index.ts` | (modify) export hostrunner |
| `pnpm-workspace.yaml` | (modify) add `adapters/*` |
| `package.json` | (modify) typecheck script covers adapters |
| `adapters/opencode/package.json` | `@tinystrap/adapter-opencode` — deps: core, policy (workspace) only |
| `adapters/opencode/tsconfig.json` | extends `tsconfig.base.json`, references core + policy |
| `adapters/opencode/src/config.ts` | `buildOpenCodeConfig()` — provider config pointing at the proxy (pure) |
| `adapters/opencode/src/argv.ts` | `buildOpenCodeArgs()` — headless argv (pure) |
| `adapters/opencode/src/parse.ts` | `parseOpenCodeJsonl()` — host events → `HarnessEvent[]` (pure) |
| `adapters/opencode/src/runner.ts` | `OpenCodeRunner implements HostRunner` — spawn, timeout, cancel, transcript |
| `adapters/opencode/plugin/tinystrap-policy.ts` | OPTIONAL tool-blocking plugin (Task 7, feasibility-gated) |
| `adapters/opencode/test/*.test.ts` | one test file per module |
| `adapters/opencode/test/fixtures/fake-host.mjs` | fake host executable: prints recorded JSONL, exits |
| `adapters/pi/package.json` | `@tinystrap/adapter-pi` — same shape |
| `adapters/pi/src/runner.ts` | `PiRunner implements HostRunner` (small; config mechanism to verify) |
| `adapters/pi/test/runner.test.ts` | fake-executable test |
| `scripts/live-host-check-opencode.mjs` | operator-gated live check (no test, never in CI) |

---

### Task 1: Extend `HarnessEventKind` with the §13.4 kinds the host layer emits

**Files:**
- Modify: `packages/policy/src/audit.ts`
- Test: `packages/policy/test/audit.test.ts` (extend existing file)

**Interfaces:**
- Consumes: existing `HarnessEvent` / `makeEvent` (above).
- Produces: `HarnessEventKind` additionally includes `"tool_executed" | "tool_failed" | "tool_call_repaired" | "host_event"`; `HarnessEvent` gains optional `hostEventType?: string` (the raw host event `type` carried on `host_event` records).

Why: spec §13.4 lists `tool_executed`, `tool_failed`, `tool_call_repaired` among the shared event kinds; `audit.ts` on `main` lacks them (verified above). `host_event` is the lossless fallback for host output we cannot map — spec §13.3 requires translation to the shared model, not silent drops.

Steps:

- [ ] Extend `packages/policy/test/audit.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { makeEvent } from "@tinystrap/policy";

describe("host-layer event kinds (spec 13.4)", () => {
  it("carries tool_executed with a tool name", () => {
    const e = makeEvent("t1", "tool_executed", { tool: "write" });
    expect(e.kind).toBe("tool_executed");
  });
  it("carries tool_failed and tool_call_repaired", () => {
    expect(makeEvent("t1", "tool_failed", { reason: "exit 1" }).kind).toBe("tool_failed");
    expect(makeEvent("t1", "tool_call_repaired", { tool: "edit" }).kind).toBe("tool_call_repaired");
  });
  it("carries host_event with the raw host type preserved", () => {
    const e = makeEvent("t1", "host_event", { hostEventType: "session.idle" });
    expect(e.hostEventType).toBe("session.idle");
  });
});
```

- [ ] Run `pnpm test -- audit`. Expected: FAIL — TS errors on the unknown kinds / field.
- [ ] In `packages/policy/src/audit.ts`, append to the union and add the field:

```ts
export type HarnessEventKind =
  | "tool_request" | "tool_allowed" | "tool_denied" | "tool_asked"
  | "evasion_flagged" | "script_rescanned" | "task_created"
  | "baseline_captured" | "patch_extracted" | "patch_exported"
  | "tool_stream_started" | "tool_interrupted" | "reasoning_intervention"
  | "tool_executed" | "tool_failed" | "tool_call_repaired" | "host_event";

export type HarnessEvent = {
  taskId: string;
  timestamp: string;
  kind: HarnessEventKind;
  tool?: string;
  argumentsDigest?: string;
  decision?: string;
  reason?: string;
  effectSignature?: string;
  hostEventType?: string;
};
```

- [ ] Run `pnpm test` and `pnpm typecheck`. Expected: PASS — the union extension is additive; no existing consumer breaks.
- [ ] Commit: `feat(policy): add spec-13.4 event kinds the host layer emits`

---

### Task 2: The `HostRunner` contract in core

**Files:**
- Create: `packages/core/src/hostrunner.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/hostrunner.test.ts`

**Interfaces:**
- Consumes: `HarnessEvent` from `@tinystrap/policy` (core already depends on policy).
- Produces (exported from `@tinystrap/core`) — the contract every adapter implements and the bench plan consumes:

```ts
export type HostTask = {
  taskId: string;          // for events; TaskHandle.taskId
  prompt: string;          // the task instruction handed to the host
  workspaceDir: string;    // TaskHandle.workspaceDir — the host's cwd
  logsDir: string;         // TaskHandle.logsDir — transcript goes here
  model: string;           // model id the host should request, e.g. "qwen2.5-coder-7b"
  proxyBaseUrl: string;    // http://127.0.0.1:<port> — from startProxy(); never hardcoded
  timeoutMs: number;       // hard cap; on trip kill the host and report timedOut
};

export type HostRunResult = {
  exitCode: number;        // host process exit code; -1 if killed before exit
  events: HarnessEvent[];  // normalized from host output (spec 13.3)
  transcriptPath: string;  // <logsDir>/host-transcript.jsonl — raw host stdout lines
  timedOut: boolean;       // true when the timeout tripped
  cancelled: boolean;      // true when the caller's AbortSignal tripped
};

export interface HostRunner {
  run(task: HostTask, signal?: AbortSignal): Promise<HostRunResult>;
}
```

Design notes (record these in the file as a 3-line comment, no more): `proxyBaseUrl` is the *only* model endpoint a host may see (spec §10.1); `signal` is how the supervisor cancels (spec §6 "a way for the caller to cancel"); the transcript is raw host output kept beside the task for audit.

Steps:

- [ ] Write `packages/core/test/hostrunner.test.ts` — a compile-time contract test plus a trivial in-test implementation (this is a types-only module; the test proves the shape is implementable and exported):

```ts
import { describe, expect, it } from "vitest";
import { makeEvent } from "@tinystrap/policy";
import type { HostRunner, HostTask, HostRunResult } from "@tinystrap/core";

class StubRunner implements HostRunner {
  async run(task: HostTask): Promise<HostRunResult> {
    return {
      exitCode: 0,
      events: [makeEvent(task.taskId, "host_event", { hostEventType: "stub" })],
      transcriptPath: `${task.logsDir}/host-transcript.jsonl`,
      timedOut: false,
      cancelled: false,
    };
  }
}

describe("HostRunner contract", () => {
  it("a stub runner satisfies the interface", async () => {
    const r = await new StubRunner().run({
      taskId: "t1", prompt: "p", workspaceDir: "/w", logsDir: "/l",
      model: "m", proxyBaseUrl: "http://127.0.0.1:8787", timeoutMs: 1000,
    });
    expect(r.exitCode).toBe(0);
    expect(r.events[0].kind).toBe("host_event");
    expect(r.transcriptPath).toContain("host-transcript.jsonl");
  });
});
```

- [ ] Run `pnpm test -- hostrunner` in `packages/core`. Expected: FAIL — module not found.
- [ ] Create `packages/core/src/hostrunner.ts` with the three exported types above (`import type { HarnessEvent } from "@tinystrap/policy";` — type-only import, no runtime dep added).
- [ ] Add `export * from "./hostrunner.js";` to `packages/core/src/index.ts`.
- [ ] Run `pnpm test` + `pnpm typecheck`. Expected: PASS.
- [ ] Commit: `feat(core): HostRunner contract for headless host adapters`

---

### Task 3: Wire `adapters/*` into the workspace and scaffold `@tinystrap/adapter-opencode`

**Files:**
- Modify: `pnpm-workspace.yaml`, `package.json` (root)
- Create: `adapters/opencode/package.json`, `adapters/opencode/tsconfig.json`, `adapters/opencode/src/index.ts`, `adapters/opencode/test/smoke.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: package `@tinystrap/adapter-opencode` resolvable via `workspace:*`; root typecheck covers it.

Why core not a new `packages/host` for shared types: stated in Architecture; the workspace change here is the only layout cost.

Steps:

- [ ] `pnpm-workspace.yaml` — add the adapters glob:

```yaml
packages:
  - packages/*
  - apps/*
  - adapters/*
```

- [ ] Root `package.json` — extend the typecheck script (keep existing order, append adapters):

```json
"typecheck": "tsc -b packages/policy packages/discovery packages/proxy packages/core apps/cli adapters/opencode"
```

- [ ] Create `adapters/opencode/package.json`:

```json
{
  "name": "@tinystrap/adapter-opencode",
  "version": "0.0.0",
  "type": "module",
  "main": "src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@tinystrap/core": "workspace:*",
    "@tinystrap/policy": "workspace:*"
  }
}
```

- [ ] Create `adapters/opencode/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"],
  "references": [{ "path": "../../packages/core" }, { "path": "../../packages/policy" }]
}
```

- [ ] Create `adapters/opencode/src/index.ts`: `export {};`
- [ ] Write `adapters/opencode/test/smoke.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import * as adapter from "@tinystrap/adapter-opencode";

describe("adapter-opencode package", () => {
  it("resolves with only workspace deps", () => {
    expect(adapter).toBeDefined();
  });
});
```

- [ ] Run `pnpm install` (timeout ≥ 120s), then `pnpm test -- smoke` and `pnpm typecheck`. Expected: PASS.
- [ ] Commit: `chore(adapters): workspace wiring + opencode adapter scaffold`

---

### Task 4: `buildOpenCodeConfig` — point OpenCode's model endpoint at the proxy

**Files:**
- Create: `adapters/opencode/src/config.ts`
- Modify: `adapters/opencode/src/index.ts`
- Test: `adapters/opencode/test/config.test.ts`

**Interfaces:**
- Consumes: nothing (pure data in / pure object out).
- Produces:

```ts
export type OpenCodeProviderConfig = {
  provider: Record<string, {
    npm: string;
    name: string;
    options: { baseURL: string; apiKey: string };
    models: Record<string, Record<string, never>>;
  }>;
};
export function buildOpenCodeConfig(proxyBaseUrl: string, modelId: string): OpenCodeProviderConfig;
```

The generated object is an opencode `provider` block for an OpenAI-compatible endpoint (`@ai-sdk/openai-compatible`), so the host addresses the model as `tinystrap/<modelId>`. `apiKey` is a fixed dummy (`"tinystrap"`) — the proxy does not authenticate; the value exists only because the AI-SDK provider requires a non-empty key. `proxyBaseUrl` arrives from `startProxy()`'s return value; the function **must** reject anything that is not loopback to fail loudly if a caller ever tries to point the host at a public endpoint.

Steps:

- [ ] Write `adapters/opencode/test/config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildOpenCodeConfig } from "@tinystrap/adapter-opencode";

describe("buildOpenCodeConfig", () => {
  it("points the tinystrap provider at the proxy URL with /v1 appended", () => {
    const cfg = buildOpenCodeConfig("http://127.0.0.1:54321", "qwen2.5-coder-7b");
    const p = cfg.provider.tinystrap;
    expect(p.npm).toBe("@ai-sdk/openai-compatible");
    expect(p.options.baseURL).toBe("http://127.0.0.1:54321/v1");
    expect(p.models["qwen2.5-coder-7b"]).toEqual({});
  });
  it("tolerates a trailing slash on the proxy URL exactly once", () => {
    const cfg = buildOpenCodeConfig("http://127.0.0.1:54321/", "m");
    expect(cfg.provider.tinystrap.options.baseURL).toBe("http://127.0.0.1:54321/v1");
  });
  it("refuses non-loopback proxy URLs (spec 10.1: host talks only to the proxy)", () => {
    expect(() => buildOpenCodeConfig("https://api.openai.com", "m")).toThrow(/loopback/);
    expect(() => buildOpenCodeConfig("http://example.invalid", "m")).toThrow(/loopback/);
  });
});
```

- [ ] Run `pnpm test -- config` in the adapter. Expected: FAIL.
- [ ] Implement `adapters/opencode/src/config.ts`:

```ts
export type OpenCodeProviderConfig = {
  provider: Record<string, {
    npm: string;
    name: string;
    options: { baseURL: string; apiKey: string };
    models: Record<string, Record<string, never>>;
  }>;
};

export function buildOpenCodeConfig(proxyBaseUrl: string, modelId: string): OpenCodeProviderConfig {
  const u = new URL(proxyBaseUrl);
  const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
  if (!loopback) throw new Error(`proxy URL must be loopback, got ${proxyBaseUrl}`);
  const base = proxyBaseUrl.replace(/\/+$/, "");
  return {
    provider: {
      tinystrap: {
        npm: "@ai-sdk/openai-compatible",
        name: "tinystrap proxy",
        options: { baseURL: `${base}/v1`, apiKey: "tinystrap" },
        models: { [modelId]: {} },
      },
    },
  };
}
```

- [ ] Export from `index.ts`: `export * from "./config.js";`
- [ ] Run `pnpm test` + `pnpm typecheck`. Expected: PASS.
- [ ] Commit: `feat(adapter-opencode): provider config builder pointing at the proxy`

**To verify (record in findings, do not block):** opencode 1.18.x reads a project-level `opencode.json` and honors the `provider` block with `npm: "@ai-sdk/openai-compatible"` (documented mechanism). Task 6's fallback writes the file into the workspace; if opencode's config discovery differs, adjust Task 6's write location, not this builder's shape.

---

### Task 5: `buildOpenCodeArgs` and `parseOpenCodeJsonl`

**Files:**
- Create: `adapters/opencode/src/argv.ts`, `adapters/opencode/src/parse.ts`
- Modify: `adapters/opencode/src/index.ts`
- Test: `adapters/opencode/test/argv.test.ts`, `adapters/opencode/test/parse.test.ts`

**Interfaces:**
- Consumes: `HostTask` from `@tinystrap/core` (Task 2); `HarnessEvent`, `makeEvent` from `@tinystrap/policy` (Task 1's extension).
- Produces:

```ts
export function buildOpenCodeArgs(task: HostTask): string[];
export function parseOpenCodeJsonl(taskId: string, lines: string[]): HarnessEvent[];
```

Verified facts used: `opencode run` accepts `--dir <path>`, `--model <provider/model>`, `--format json`, `--pure` (skip external plugin fetch — keeps headless runs hermetic and prevents the host from pulling networked plugins). `--auto` is deliberately **not** passed: auto-approving host permissions would bypass the tinystrap gate story; denials arrive as `harness_notice` rewrites from the proxy instead (spec §10.2).

Steps:

- [ ] Write `adapters/opencode/test/argv.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildOpenCodeArgs } from "@tinystrap/adapter-opencode";
import type { HostTask } from "@tinystrap/core";

const task: HostTask = {
  taskId: "t1", prompt: "fix the off-by-one", workspaceDir: "C:/ws/t1",
  logsDir: "C:/ws/t1/logs", model: "qwen2.5-coder-7b",
  proxyBaseUrl: "http://127.0.0.1:54321", timeoutMs: 600_000,
};

describe("buildOpenCodeArgs", () => {
  it("builds headless run argv with dir, model, json format, pure", () => {
    const args = buildOpenCodeArgs(task);
    expect(args.slice(0, 2)).toEqual(["run", "--format"]);
    expect(args).toContain("json");
    expect(args).toContain("--pure");
    expect(args[args.indexOf("--dir") + 1]).toBe("C:/ws/t1");
    expect(args[args.indexOf("--model") + 1]).toBe("tinystrap/qwen2.5-coder-7b");
    expect(args.at(-1)).toBe("fix the off-by-one");   // prompt last, as one arg
  });
  it("never passes --auto (host permissions stay with the harness)", () => {
    expect(buildOpenCodeArgs(task)).not.toContain("--auto");
  });
});
```

- [ ] Write `adapters/opencode/test/parse.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseOpenCodeJsonl } from "@tinystrap/adapter-opencode";

const L = (o: unknown) => JSON.stringify(o);

describe("parseOpenCodeJsonl", () => {
  it("maps tool events to tool_executed / tool_failed", () => {
    const events = parseOpenCodeJsonl("t1", [
      L({ type: "tool_use", tool: "write", callID: "c1" }),
      L({ type: "tool_result", tool: "write", callID: "c1", output: "ok" }),
      L({ type: "tool_error", tool: "edit", callID: "c2", error: "oldText not found" }),
    ]);
    expect(events.map((e) => e.kind)).toEqual(["tool_executed", "tool_executed", "tool_failed"]);
    expect(events[0].tool).toBe("write");
    expect(events[2].reason).toBe("oldText not found");
  });
  it("keeps unmapped types losslessly as host_event", () => {
    const events = parseOpenCodeJsonl("t1", [L({ type: "session.idle" }), L({ type: "step_finish" })]);
    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe("host_event");
    expect(events[0].hostEventType).toBe("session.idle");
  });
  it("survives blank and malformed lines", () => {
    const events = parseOpenCodeJsonl("t1", ["", "{not json", L({ type: "text", text: "hi" })]);
    expect(events).toHaveLength(3);                       // nothing dropped (spec 13.3)
    expect(events[1].kind).toBe("host_event");
    expect(events[1].hostEventType).toBe("unparsed");
    expect(events[2].kind).toBe("host_event");
    expect(events[2].hostEventType).toBe("text");
  });
});
```

- [ ] Run `pnpm test -- argv parse`. Expected: FAIL.
- [ ] Implement `adapters/opencode/src/argv.ts`:

```ts
import type { HostTask } from "@tinystrap/core";

export function buildOpenCodeArgs(task: HostTask): string[] {
  return [
    "run",
    "--format", "json",
    "--pure",
    "--dir", task.workspaceDir,
    "--model", `tinystrap/${task.model}`,
    task.prompt,
  ];
}
```

- [ ] Implement `adapters/opencode/src/parse.ts`:

```ts
import { makeEvent, type HarnessEvent } from "@tinystrap/policy";

type Raw = { type?: unknown; tool?: unknown; error?: unknown };

export function parseOpenCodeJsonl(taskId: string, lines: string[]): HarnessEvent[] {
  const out: HarnessEvent[] = [];
  for (const line of lines) {
    if (!line.trim()) {
      out.push(makeEvent(taskId, "host_event", { hostEventType: "blank" }));
      continue;
    }
    let raw: Raw;
    try { raw = JSON.parse(line) as Raw; }
    catch { out.push(makeEvent(taskId, "host_event", { hostEventType: "unparsed" })); continue; }
    const tool = typeof raw.tool === "string" ? raw.tool : undefined;
    switch (raw.type) {
      case "tool_use":
      case "tool_result":
        out.push(makeEvent(taskId, "tool_executed", { tool }));
        break;
      case "tool_error":
        out.push(makeEvent(taskId, "tool_failed", {
          tool, reason: typeof raw.error === "string" ? raw.error : undefined,
        }));
        break;
      default:
        out.push(makeEvent(taskId, "host_event", {
          hostEventType: typeof raw.type === "string" ? raw.type : "unknown",
        }));
    }
  }
  return out;
}
```

- [ ] Export both from `index.ts`. Run `pnpm test` + `pnpm typecheck`. Expected: PASS.
- [ ] Commit: `feat(adapter-opencode): headless argv builder and JSONL event parser`

**To verify (record in findings, do not block):** the exact per-line event shapes of `opencode run --format json` on 1.18.x. The parser is deliberately tolerant (map known, `host_event` everything else, never drop) so a shape mismatch degrades to more `host_event` rows, not lost runs. Task 9's live check confirms the real shapes; if `tool_use`/`tool_result`/`tool_error` differ, adjust the switch table only.

---

### Task 6: `OpenCodeRunner` — spawn, transcript, timeout, cancellation

**Files:**
- Create: `adapters/opencode/src/runner.ts`
- Modify: `adapters/opencode/src/index.ts`
- Create: `adapters/opencode/test/fixtures/fake-host.mjs`
- Test: `adapters/opencode/test/runner.test.ts`

**Interfaces:**
- Consumes: `HostRunner`, `HostTask`, `HostRunResult` from `@tinystrap/core`; `buildOpenCodeConfig` (Task 4); `buildOpenCodeArgs`, `parseOpenCodeJsonl` (Task 5).
- Produces:

```ts
export type OpenCodeRunnerOptions = {
  bin?: string;          // default "opencode"
  binPrefixArgs?: string[]; // default []; tests inject `node <fake-host.mjs>`
};
export class OpenCodeRunner implements HostRunner {
  constructor(opts?: OpenCodeRunnerOptions);
  run(task: HostTask, signal?: AbortSignal): Promise<HostRunResult>;
}
```

Config delivery: the runner writes `opencode.json` (the Task 4 object) into `task.workspaceDir`. It stays **untracked** — `extractPatch()` diffs tracked files, so an untracked config file cannot leak into the patch — and the runner deletes it after the run. **To verify:** if opencode 1.18.x honors an `OPENCODE_CONFIG` env var, switch to a temp-dir config and set it in the child env; the fallback above works regardless and is the default here.

Steps:

- [ ] Create `adapters/opencode/test/fixtures/fake-host.mjs` — a fake host executable that ignores its args (except `--sleep <ms>`), prints recorded JSONL lines, and exits:

```js
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
```

- [ ] Write `adapters/opencode/test/runner.test.ts` (temp dirs created/removed in Node; `mkdtempSync`, `rmSync` in `afterEach`):

```ts
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { HostTask } from "@tinystrap/core";
import { OpenCodeRunner } from "@tinystrap/adapter-opencode";

const FAKE = join(fileURLToPath(import.meta.url), "../../fixtures/fake-host.mjs");
const dirs: string[] = [];
const mkTask = (over: Partial<HostTask> = {}): HostTask => {
  const dir = mkdtempSync(join(tmpdir(), "oc-run-"));
  dirs.push(dir);
  return {
    taskId: "t1", prompt: "p", workspaceDir: dir, logsDir: dir,
    model: "m", proxyBaseUrl: "http://127.0.0.1:1", timeoutMs: 10_000, ...over,
  };
};
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const fake = (extra: string[] = []) =>
  new OpenCodeRunner({ bin: process.execPath, binPrefixArgs: [FAKE, ...extra] });

describe("OpenCodeRunner", () => {
  it("runs the fake host, writes the transcript, normalizes events", async () => {
    const task = mkTask();
    const r = await fake().run(task);
    expect(r).toMatchObject({ exitCode: 0, timedOut: false, cancelled: false });
    expect(r.events.map((e) => e.kind)).toEqual(["tool_executed", "tool_executed", "host_event"]);
    expect(r.transcriptPath).toBe(join(task.logsDir, "host-transcript.jsonl"));
    expect(readFileSync(r.transcriptPath, "utf8").trim().split("\n")).toHaveLength(3);
  });
  it("propagates a nonzero host exit code", async () => {
    expect((await fake(["--fail"]).run(mkTask())).exitCode).toBe(3);
  });
  it("kills the host on timeout and reports timedOut", async () => {
    const r = await fake(["--sleep", "5000"]).run(mkTask({ timeoutMs: 150 }));
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(-1);
  });
  it("kills the host on AbortSignal and reports cancelled", async () => {
    const ac = new AbortController();
    const p = fake(["--sleep", "5000"]).run(mkTask(), ac.signal);
    setTimeout(() => ac.abort(), 100);
    const r = await p;
    expect(r.cancelled).toBe(true);
    expect(r.timedOut).toBe(false);
  });
  it("writes opencode.json into the workspace before the run and removes it after", async () => {
    const task = mkTask();
    await fake().run(task);
    expect(existsSync(join(task.workspaceDir, "opencode.json"))).toBe(false);
  });
});
```

- [ ] Run `pnpm test -- runner` in the adapter. Expected: FAIL.
- [ ] Implement `adapters/opencode/src/runner.ts`:

```ts
import { spawn } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { HostRunner, HostTask, HostRunResult } from "@tinystrap/core";
import { buildOpenCodeConfig } from "./config.js";
import { buildOpenCodeArgs } from "./argv.js";
import { parseOpenCodeJsonl } from "./parse.js";

export type OpenCodeRunnerOptions = {
  bin?: string;
  binPrefixArgs?: string[];
};

export class OpenCodeRunner implements HostRunner {
  constructor(private readonly opts: OpenCodeRunnerOptions = {}) {}

  run(task: HostTask, signal?: AbortSignal): Promise<HostRunResult> {
    const configPath = join(task.workspaceDir, "opencode.json");
    writeFileSync(configPath, JSON.stringify(buildOpenCodeConfig(task.proxyBaseUrl, task.model), null, 2));
    const transcriptPath = join(task.logsDir, "host-transcript.jsonl");

    return new Promise<HostRunResult>((resolve) => {
      const child = spawn(this.opts.bin ?? "opencode",
        [...(this.opts.binPrefixArgs ?? []), ...buildOpenCodeArgs(task)],
        { cwd: task.workspaceDir, stdio: ["ignore", "pipe", "pipe"], shell: false });

      let raw = "";
      child.stdout.on("data", (d: Buffer) => { raw += d.toString(); });

      let timedOut = false;
      let cancelled = false;
      const killer = () => { timedOut = true; child.kill("SIGKILL"); };
      const aborter = () => { cancelled = true; child.kill("SIGKILL"); };
      const timer = setTimeout(killer, task.timeoutMs);
      signal?.addEventListener("abort", aborter, { once: true });

      child.on("error", () => { /* missing bin: resolve below with exitCode -1 */ });
      child.on("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", aborter);
        writeFileSync(transcriptPath, raw);
        try { rmSync(configPath, { force: true }); } catch { /* best effort */ }
        const lines = raw.split("\n");
        resolve({
          exitCode: code ?? -1,
          events: parseOpenCodeJsonl(task.taskId, lines),
          transcriptPath,
          timedOut,
          cancelled,
        });
      });
    });
  }
}
```

Note for the implementer: on Windows, `child.kill("SIGKILL")` kills the direct child only. opencode's `run` is the process we care about (it does the model calls in-process); if the live check (Task 9) shows opencode spawning tool subprocesses that survive, escalate to `taskkill /F /T /PID <pid>` via `spawnSync` — record the finding, do not pre-build it.

- [ ] Export `OpenCodeRunner` from `index.ts`. Run `pnpm test` + `pnpm typecheck`. Expected: PASS.
- [ ] Commit: `feat(adapter-opencode): OpenCodeRunner with transcript, timeout, cancellation`

---

### Task 7: OPTIONAL — OpenCode tool-blocking plugin (feasibility-gated, spec Appendix A7)

**Files:**
- Create (only if feasible): `adapters/opencode/plugin/tinystrap-policy.ts`
- Record: `docs/superpowers/spike-findings/opencode-plugin-api.md` (always — the finding is the deliverable either way)

**Interfaces:**
- Consumes: `evaluate(req: ToolRequest, ctx: PolicyContext): PolicyDecision` from `@tinystrap/policy`; `ToolRequest = { tool, args, cwd, taskId, phase }`.
- Produces: an opencode plugin module that, on the host's tool-execution hook, calls `evaluate()` and blocks denied calls with the decision's `reason`/`correction` text fed back to the model.

**Gate (hard rule from Appendix A7):** step 1 is a manual probe against the **installed opencode 1.18.x**. If its plugin/event API does not expose a pre-execution tool hook that can *cancel* the call, **stop**: write the finding, delete nothing, and move on — the proxy gate (already built and tested) remains the enforcement point and the rest of the plan never depended on this task.

Steps:

- [ ] Probe: read the installed opencode's plugin documentation/types (`opencode` package's exported plugin types on the machine, or its docs) and write a 5-line spike plugin that logs and denies one tool call. Run it headlessly on a trivial prompt **without** the proxy (echo model not required — deny happens before any model call matters). Record in `docs/superpowers/spike-findings/opencode-plugin-api.md`: hook name, signature, whether denial is honored, opencode version.
- [ ] If infeasible: commit the finding file with `docs(spike): opencode plugin API cannot block tool calls (A7 negative)` and **end the task** — skip the remaining steps.
- [ ] If feasible: write `adapters/opencode/plugin/tinystrap-policy.ts`:

```ts
import { evaluate, createToolRegistry, EvasionTracker, ScriptLedger } from "@tinystrap/policy";
import type { Plugin } from "opencode/plugin"; // exact import path: to verify from installed types

// The plugin is defense-in-depth ONLY: the proxy preflight is the enforcement
// point (spec 10.1). Context here is deliberately narrow: unknown tools and
// out-of-workspace paths are denied; everything else defers to the proxy.
export const TinystrapPolicyPlugin: Plugin = () => ({
  "tool.execute.before": async (input, output) => {
    const ctx = {
      workspaceRoot: process.cwd(),
      registry: createToolRegistry(),
      readSet: new Set<string>(),
      exists: () => false,
      realPaths: new Map<string, string>(),
      ledger: new ScriptLedger(),
      evasion: new EvasionTracker(),
    };
    const decision = evaluate(
      { tool: input.tool, args: output.args as Record<string, unknown>,
        cwd: process.cwd(), taskId: "host", phase: "execute" as never },
      ctx,
    );
    if (decision.effect === "deny") {
      throw new Error(`tinystrap: ${decision.reason} ${decision.correction ?? ""}`.trim());
    }
  },
});
```

- [ ] Verify end-to-end once, headless, with the plugin enabled and the proxy running: a denied tool call must surface the tinystrap reason to the model. Record the transcript excerpt in the findings file.
- [ ] Commit: `feat(adapter-opencode): tool-blocking plugin (A7 feasibility verified)`

(No automated test for this task: it runs inside the host process, not ours. The live verification transcript in the findings file is its evidence.)

---

### Task 8: `PiRunner` — second host behind the same contract (smaller task)

**Files:**
- Create: `adapters/pi/package.json`, `adapters/pi/tsconfig.json`, `adapters/pi/src/runner.ts`, `adapters/pi/src/index.ts`, `adapters/pi/test/fixtures/fake-host.mjs`, `adapters/pi/test/runner.test.ts`
- Modify: root `package.json` (typecheck script)

**Interfaces:**
- Consumes: `HostRunner`/`HostTask`/`HostRunResult` from `@tinystrap/core`; `makeEvent` from `@tinystrap/policy`.
- Produces: `class PiRunner implements HostRunner` with the same `OpenCodeRunnerOptions`-shaped options (`bin`, `binPrefixArgs`).

Verified facts used: `pi -p --mode json` runs non-interactively and emits JSONL on stdout. **To verify:** how pi selects an OpenAI-compatible base URL (env var `OPENAI_BASE_URL` vs a config file vs a CLI flag) — the runner passes it via env `OPENAI_BASE_URL=${proxyBaseUrl}/v1` as the first guess and the live check confirms; the shape of pi's JSONL events (parser is tolerant, same pattern as Task 5).

Steps:

- [ ] Scaffold `adapters/pi` exactly like Task 3 (package name `@tinystrap/adapter-pi`, deps core + policy, tsconfig references), append `adapters/pi` to the root typecheck script.
- [ ] Write `adapters/pi/test/fixtures/fake-host.mjs` (same shape as Task 6's fake) and `adapters/pi/test/runner.test.ts` asserting: exit code propagation, transcript at `<logsDir>/host-transcript.jsonl`, timeout (`timedOut: true`), cancellation (`cancelled: true`), and that the child env carries `OPENAI_BASE_URL` ending in `/v1` (the fake host writes `process.env.OPENAI_BASE_URL` into one JSONL line the test asserts on).
- [ ] Implement `adapters/pi/src/runner.ts`: same spawn/timeout/abort skeleton as Task 6 (extract the shared skeleton into `adapters/pi/src/spawnutil.ts` **only if** copying it twice is uglier than the duplication — default: copy, ~40 lines, YAGNI on a shared-abstraction package), argv `["-p", "--mode", "json", task.prompt]`, env `{ ...process.env, OPENAI_BASE_URL: `${task.proxyBaseUrl.replace(/\/+$/, "")}/v1` }`, events via a local tolerant parser emitting `host_event`/`tool_executed`/`tool_failed` like Task 5.
- [ ] Run `pnpm install` (≥120s), `pnpm test`, `pnpm typecheck`. Expected: PASS.
- [ ] Commit: `feat(adapter-pi): PiRunner behind the shared HostRunner contract`

---

### Task 9: Operator-gated live check script

**Files:**
- Create: `scripts/live-host-check-opencode.mjs`

**Interfaces:**
- Consumes: `OpenCodeRunner` from `@tinystrap/adapter-opencode`, `startProxy` + `HttpProvider` from `@tinystrap/proxy`, `createTask`/`extractPatch`/`destroyTask` from `@tinystrap/core`, `createToolRegistry`, `evaluate` from `@tinystrap/policy`.
- Produces: nothing importable — a manual script. **Not** wired into `pnpm test`; requires the operator to have a local model server already running (the script never starts one and never contacts a non-loopback address).

Steps:

- [ ] Write `scripts/live-host-check-opencode.mjs`:

```js
// Operator-gated: verifies the OpenCode adapter end-to-end against a REAL local
// model server the operator already started. Usage:
//   node scripts/live-host-check-opencode.mjs --base-url http://127.0.0.1:8080 --model qwen2.5-coder-7b
// Refuses non-loopback URLs. Never run from CI.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProxy, HttpProvider } from "@tinystrap/proxy";
import { createTask, extractPatch, destroyTask } from "@tinystrap/core";
import { createToolRegistry, evaluate } from "@tinystrap/policy";
import { OpenCodeRunner } from "@tinystrap/adapter-opencode";

const argv = process.argv.slice(2);
const flag = (n) => argv[argv.indexOf(n) + 1];
const baseUrl = flag("--base-url");
const model = flag("--model");
if (!baseUrl || !model) {
  console.error("usage: live-host-check-opencode.mjs --base-url http://127.0.0.1:<port> --model <id>");
  process.exit(2);
}
if (!/127\.0\.0\.1|localhost/.test(baseUrl)) {
  console.error("refusing non-loopback base URL");
  process.exit(2);
}

const projectRoot = mkdtempSync(join(tmpdir(), "live-host-"));
writeFileSync(join(projectRoot, "hello.txt"), "wrld\n");
const handle = await createTask(projectRoot);
const registry = createToolRegistry();
const proxy = await startProxy({
  provider: new HttpProvider({ baseUrl }),
  registry,
  preflight: (tool, args) => evaluate(
    { tool, args, cwd: handle.workspaceDir, taskId: handle.taskId, phase: "execute" },
    { workspaceRoot: handle.workspaceDir, registry, readSet: new Set(),
      exists: () => false, realPaths: new Map(), ledger: null, evasion: null },
  ),
  onEvent: (e) => console.log(`[event] ${e.kind} ${e.tool ?? ""}`),
});

const result = await new OpenCodeRunner().run({
  taskId: handle.taskId,
  prompt: "Change hello.txt to contain exactly: hello world",
  workspaceDir: handle.workspaceDir, logsDir: handle.logsDir,
  model, proxyBaseUrl: proxy.url, timeoutMs: 300_000,
});
await proxy.close();

console.log({ exitCode: result.exitCode, timedOut: result.timedOut,
  cancelled: result.cancelled, transcript: result.transcriptPath });
console.log("patch:\n" + (await extractPatch(handle)).slice(0, 2000));
// Keep the task dir for inspection; print it instead of deleting:
console.log("task dir:", handle.taskDir);
```

(The `ledger: null, evasion: null` above is a placeholder the implementer must replace with `new ScriptLedger()` / `new EvasionTracker()` — write it correctly from the start; the point of this script is the real wiring.)

- [ ] Run `pnpm typecheck` — the script lives in `scripts/` (not in any tsconfig include), so confirm it at least parses: `node --check scripts/live-host-check-opencode.mjs`. Expected: OK.
- [ ] **Manual run (operator):** with a local llama.cpp server up, run the usage line above. Record the outcome — success or the exact failure — in `docs/superpowers/spike-findings/opencode-live-check.md` (event shapes seen by the parser, whether the config file was picked up, whether the patch extracted). This file is the acceptance evidence for Tasks 4–6 against the real host.
- [ ] Commit: `feat(scripts): operator-gated live host check for opencode`

---

## Verification (whole plan)

- `pnpm test` — all packages green, **no network** (fake executables only).
- `pnpm typecheck` — includes `adapters/opencode` and `adapters/pi`.
- Manual (operator, optional but recommended once): Task 9 live check against a local server; findings recorded.
- Grep gate: `grep -rn "http://" adapters/ | grep -v 127.0.0.1 | grep -v localhost` → no hits (the host layer can only ever point at loopback).

## Spec-vs-code gaps found while writing this plan (report upstream)

1. `HarnessEventKind` lacks the §13.4 kinds `tool_executed`, `tool_failed`, `tool_call_repaired` (Task 1 adds them; the proxy plan's `tool_call_repaired` emission still awaits wiring — see bench plan Task 3).
2. Spec §6 names no home for the host-runner abstraction — resolved here into `@tinystrap/core` (rationale in Architecture).
3. Appendix A7 (opencode plugin tool-blocking) remains **unverified** until Task 7's probe runs; the plan is structured so nothing else depends on it.
4. `opencode run --format json` per-line event shapes are **unverified** against 1.18.x; the tolerant parser degrades safely, Task 9 confirms.
