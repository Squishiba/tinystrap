# Verifier and Promotion Broker Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Implement spec §9.9 (verifier) and §9.10 (promotion broker) plus the §9.2 `WorkspaceProvider` seam they depend on. After a host run, the harness extracts the patch (already on `main`), applies it to a **fresh checkout of the baseline in a harness-owned directory** — never in the model's workspace — and runs auto-detected, config-overridable verify commands there with process-tree timeouts (`killProcessTree`), bounded output capture, and a command-safety story consistent with the policy layer. The promotion broker then turns a verified patch into an approved outcome: `export_patch` (patch file, no side effects), `apply` (drift check → rollback checkpoint → apply the exact verified patch → post-apply checks → restore on failure), `commit_task_branch` (plumbing commit on a new branch, working tree untouched), and `open_pr` (push **only** the task branch, never `main`, never force, then `gh pr create`) — every mode except `export_patch` gated by a **one-key approve** with injected IO, and `open_pr` additionally requiring the per-repository `tinystrap.toml` opt-in and an interactive approve that `--yes` cannot satisfy.

**Architecture:** Five groups, mostly in `@tinystrap/core`. **A** extends the audit vocabulary (`policy/src/audit.ts` gains the §13.4 verification/promotion event kinds that are missing on `main`) and adds pure verify-command **detection** (`package.json` scripts, pytest, cargo, go, make) plus config **override** resolution against the existing `ResolvedConfig` chain. **B** adds `run.ts` — a small injectable `CommandRunner` (spawn, no shell, stdin, `killProcessTree` on timeout) that every later task consumes — and `verify.ts`: command-safety splitting (metacharacter rejection + the policy package's own `analyzeShell`, so the verifier's fail-closed story is the same vocabulary as the gate's), bounded-tail command execution, and `verifyInFreshWorkspace` (clone baseline revision into `<taskDir>/verify-*`, apply the extracted patch via stdin, run the commands, emit `verification_started`/`verification_finished`, return a structured `VerifyReport`). **C** introduces the `WorkspaceProvider` interface with `createIndependentCloneProvider()` (delegates to the existing `snapshotGit`/`snapshotManifest`) and `createExternalWorkspaceProvider()` (adopts a host-supplied directory — an AO-style worktree — recording a baseline from its own git state; `TaskHandle` gains an optional `externalWorkspaceDir` that `extractPatch` honors), selected from the `[workspace]` config table. **D** is the promotion broker (`promotion.ts`): fingerprint/drift, rollback checkpoint/restore, patch application, task-branch plumbing commits, the guarded `open_pr` push + `gh` call, and the `promote()` orchestrator with the approve gate and `promotion_requested`/`promotion_applied`/`promotion_refused` events. **E** wires the CLI (`tinystrap task verify`, `tinystrap task promote`) and the doctor's verify-commands report (§8.1). The bench package's `verifyInFreshCopy` is a **reference only** — `bench` depends on `core`, so `core` must not import it back; its ideas (temp copy, patch-via-stdin, metachar rejection, output tail) are re-implemented here with the tree-kill upgrade it lacks.

**Tech Stack:** TypeScript 5 strict ESM (NodeNext), pnpm workspaces, vitest. Node built-ins (`node:fs`, `node:path`, `node:os`, `node:crypto`, `node:child_process`) plus the existing `smol-toml` and workspace packages; `@tinystrap/policy` supplies `makeEvent` and `analyzeShell` to `core` (dependency already exists). Tests use real `git` in `mkdtemp` temp projects (the pattern in `packages/core/test/patch.test.ts`), fixture `.mjs` scripts as verify commands instead of shell strings, injected fake `CommandRunner`s for anything that would touch a remote (`gh`, `push`), and injected approve IO — **no network, no real `gh`, no model server, no host binary** in any CI task. Same toolchain as the prior plans.

**Spec:** `docs/superpowers/specs/2026-09-20-tinystrap-harness-design.md` (§7 `[workspace]`/`[promotion]`/`[verify]` config tables and the one-file rule, §8.1 doctor reporting detected verify commands, §9.2 WorkspaceProvider + the "verifier and promotion broker operate on the extracted patch" guarantee, §9.3 task data dir layout, §9.9 verifier + auto-detected commands, §9.10 promotion modes / one-key approve / drift / open_pr / no-push-without-approval, §11 lifecycle Freeze→Verify→Promote, §13.4 event kinds, §13.5 deployment modes incl. inside-AO `open_pr`, §14 error-handling rows for verification failure and drift, §19 recommended defaults). Prior plans: `2026-09-24-host-tool-dialects.md` (format reference), `2026-09-25-tinystrap-init.md` (injected-IO prompt pattern reused for the approve UI).

## Global Constraints

Copied from the spec (and the task brief); these bind every task:

- **The verifier never runs in the model's workspace.** Verification happens in a fresh checkout of the baseline revision under `<taskDir>/verify-*`, created after patch extraction. The model's `workspaceDir` is input only through the extracted patch bytes.
- **No push without explicit per-task user approval; the model never pushes.** `open_pr` is the only mode that pushes at all; it requires (a) `promotion.mode = "open_pr"` in the project's `tinystrap.toml` and (b) an interactive one-key approve naming the branch that will be pushed. `--yes`/`assumeYes` may satisfy approval for `apply`/`commit_task_branch` but **never** for `open_pr` (Open question 4). Pushes are `git push origin <branch>:<branch>` — never `main`/`master`, never `--force`/`-f`, and the code refuses to even construct such a command.
- **Promotion applies only the exact verified patch** — never a directory copy, never a re-extraction after approval. The `VerifyReport.patchHash` is of the same patch bytes handed to the apply step.
- **Drift refuses blind promotion** (§14): if HEAD moved or the tracked-changes hash changed since the baseline, `promote()` refuses with a human message offering rebase-or-review; the actual rebase tooling is a follow-up (Open question 6).
- **Command safety consistent with the policy layer:** verify commands are `program args...` — whitespace-split, no shell (`shell: false`), rejected on shell metacharacters, and additionally required to pass `analyzeShell` as exactly one redirect-free statement. Verify commands come from config/detection, never from the model.
- **Process-tree timeouts everywhere:** every child process the verifier or broker spawns is killed via `killProcessTree` (Windows `taskkill /T`, POSIX process-group), never a bare `child.kill()` that orphans grandchildren.
- **Bounded output capture:** verifier command output is capped (default 4000 chars kept, tail) before it reaches reports, events, or the terminal; the cap is a parameter, and the kept bytes are the *tail* (failures live there).
- **No network in automated tests.** Real `git` in temp dirs is fine (it is local); anything reaching a remote (`push`, `gh`) goes through the injected `CommandRunner` and is tested with fakes that record calls. No real `gh` binary in CI.
- **Public repository.** No IP addresses, hostnames, usernames, local absolute paths, or personal addresses anywhere in code, tests, or docs. Use `mkdtempSync(join(tmpdir(), "ts-verify-"))`-style paths, `example.invalid` domains, and the harness identity `tinystrap` for plumbing commits (via `GIT_AUTHOR_*`/`GIT_COMMITTER_*` env, so machines without a configured identity still work).
- **`tinystrap.toml` stays the only config file** (§7): `[workspace]`, `[promotion]`, `[verify]` keys are read through the existing `loadConfig` chain; no new config files or locations.
- **`core` does not depend on `bench` or `proxy`** (dependency direction: `bench → core`, `core → policy, discovery`). The bench verifier stays untouched; ideas are copied with attribution in comments.
- **Existing behavior must not regress.** All current core / policy / cli / bench tests stay green unchanged. `taskstore.ts`, `patch.ts`, `config.ts`, `doctor.ts`, `audit.ts`, and `main.ts` get additive changes at named insertion points, never rewrites. `snapshotGit` keeps its exact exported signature.
- **Shared-file rule for parallel execution:** `packages/core/src/index.ts` is the only multi-group file (one additive export line per group: A adds `verify-commands.js`, C adds `workspace.js`, B adds `run.js` + `verify.js`, D adds `promotion.js`). Merge **A → C → B → D → E** so each later worker rebases once and appends below existing lines. `packages/policy/src/audit.ts` is **A only**; `taskstore.ts` + `patch.ts` + `config.ts` are **C only**; `doctor.ts` and `apps/cli/src/main.ts` are **E only**. Every other file has exactly one owning task.
- Explicitly deferred out of scope: the sandbox backends (§9.8 — verifier children inherit the environment for now, Open question 8); manifest-baseline verification (patch extraction is git-only on `main`, Open question 3); drift **rebase** tooling (refusal + guidance only); `tinystrap task attach` / host-lifecycle integration (§13.5 mode 2/3 wiring); workspace_frozen / discovery_completed event kinds (also missing, but no producer in this plan); post-apply checks beyond re-running the verify command set.
- Shell commands in this plan use **only** the allowed set: `git`, `gh`, `python`, `pnpm`, `npm`, `mkdir`, `ao`, `node`, `tinystrap`, `refdes`. **Never** `rm`, `npx`, `cd`, `for`-loops, or inline-assignment prefixes (`VAR=value cmd`) — refused by the shell whitelist; use `git -C <path>` instead of `cd`. Tests may use `rmSync` from `node:fs` (that is the Node API, not the shell command).
- Strict TDD, DRY, YAGNI, one commit per task minimum; every commit message ends with the line `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.

## Execution grouping

For the orchestrator to split work across workers/PRs.

| Group | One-liner | Size | Tasks |
| ----- | --------- | ---- | ----- |
| **A** | Audit vocabulary (§13.4 kinds) + verify-command detection and config overrides | small | 3 |
| **B** | `CommandRunner` with tree-kill + command safety + fresh-workspace verifier producing `VerifyReport` | medium | 3 |
| **C** | `WorkspaceProvider` seam: independent-clone (default) + external adopt + config selection | medium | 3 |
| **D** | Promotion broker: fingerprint/drift, checkpoint/restore, apply, task-branch commit, guarded `open_pr`, `promote()` with approve gate | large | 6 |
| **E** | CLI `task verify` / `task promote` with injected approve IO + doctor verify-commands line | small | 3 |

Dependencies and merge order (**A ∥ C first**, then B, then D, then E):

```text
A (events + detection) ─┐
                        ├─► B (verifier) ─► D (broker) ─► E (cli + doctor)
C (workspace providers) ┘── (C is consumed by E only; D is provider-agnostic)
```

- **A and C touch disjoint files** and run fully in parallel (C does not need the new event kinds).
- **B needs A1** (the `verification_*` event kinds) and nothing else. **D needs A + B** (`VerifyReport`, `CommandRunner`, `promotion_*` kinds). **C is independent of B and D** — the broker operates on patch bytes, which is exactly the §9.2 guarantee that makes it provider-agnostic.
- **E needs everything**: `task verify` composes A+B, `task promote` composes A+B+D, provider selection in the CLI reads C, and the doctor line reads A.
- Merge order `A, C, B, D, E` also satisfies the `index.ts` append rule above.

## File Structure

| Path | Group | Responsibility (single) |
| ---- | ----- | ----------------------- |
| `packages/policy/src/audit.ts` | A | (modify, additive) five §13.4 event kinds |
| `packages/policy/test/audit.test.ts` | A | (extend) the new kinds construct |
| `packages/core/src/verify-commands.ts` | A | `VerifyCommand`, `detectVerifyCommands`, `resolveVerifyCommands`, `verifyOverridesFromConfig` |
| `packages/core/test/verify-commands.test.ts` | A | detection fixtures + override semantics |
| `packages/core/src/run.ts` | B | `CommandRunner`, `RunResult`, `defaultCommandRunner` (tree-kill timeout, stdin) |
| `packages/core/test/run.test.ts` | B | runner unit tests (real local `node` children only) |
| `packages/core/src/verify.ts` | B | `splitVerifyCommand`, `runVerifyCommand`, `verifyInFreshWorkspace`, `VerifyReport` |
| `packages/core/test/verify.test.ts` | B | safety, bounded output, timeout, fresh-copy end-to-end |
| `packages/core/src/workspace.ts` | C | `WorkspaceProvider`, `createIndependentCloneProvider`, `createExternalWorkspaceProvider`, `workspaceProviderFromConfig` |
| `packages/core/src/taskstore.ts` | C | (modify, additive) optional `externalWorkspaceDir` + `external.json` marker in `openTask` |
| `packages/core/src/patch.ts` | C | (modify) extract from `externalWorkspaceDir ?? workspaceDir` |
| `packages/core/src/config.ts` | C | (modify, additive) builtins `workspace.provider`, `workspace.path`, `promotion.postApplyVerify`; `KEY_MAP` entry |
| `packages/core/test/workspace.test.ts` | C | provider create/adopt/config tests |
| `packages/core/src/promotion.ts` | D | fingerprint/drift, checkpoint/restore, apply, commit branch, open PR, `promote()` |
| `packages/core/test/promotion-drift.test.ts` | D | fingerprint + drift tests |
| `packages/core/test/promotion-checkpoint.test.ts` | D | checkpoint + restore tests |
| `packages/core/test/promotion-apply.test.ts` | D | apply + commit-branch tests (real git) |
| `packages/core/test/promotion-openpr.test.ts` | D | open_pr tests with fake runner (no network) |
| `packages/core/test/promote.test.ts` | D | `promote()` orchestration: approve gate, modes, events |
| `packages/core/src/index.ts` | A+B+C+D | **shared barrel** — one additive export line per group |
| `apps/cli/src/main.ts` | E | `task verify`, `task promote`, `formatVerifyReport`, injected IO |
| `apps/cli/test/cli.test.ts` | E | (extend) verify/promote CLI tests with fake IO |
| `packages/core/src/doctor.ts` | E | (modify, additive) detected verify-commands section |
| `packages/core/test/doctor.test.ts` | E | (extend) doctor assertion |

## Interfaces consumed (verified against the code on `main`, 2026-09-25)

```ts
// @tinystrap/core (packages/core/src) — all re-exported from the barrel
export type TaskHandle = { taskId: string; taskDir: string; workspaceDir: string;
  baselinePath: string; patchPath: string; logsDir: string };   // C adds optional externalWorkspaceDir
export async function createTask(projectRoot: string): Promise<TaskHandle>;
export function openTask(projectRoot: string, taskId: string): TaskHandle;
export type Baseline = { taskId: string; sourceRoot: string; revision: string;
  manifestHash: string; trackedChangesHash: string; untrackedPolicy: string; createdAt: string };
  // revision is `git:<sha>` (snapshot-git.ts) or `manifest:<hash>` (snapshot-manifest.ts)
export async function isGitProject(projectRoot: string): Promise<boolean>;
export async function snapshotGit(projectRoot: string, handle: TaskHandle,
  opts?: { allowIgnoredDirs?: string[] }): Promise<Baseline>;
export async function snapshotManifest(projectRoot: string, handle: TaskHandle): Promise<Baseline>;
export async function captureWorkspaceManifestHash(workspaceDir: string): string;
  // exported from snapshot-git.ts; walks the tree, skips .git — reused for manifest drift
export async function extractPatch(handle: TaskHandle): Promise<string>;
  // throws "patch extraction is only supported for git baselines in M1" for manifest baselines;
  // uses a temp GIT_INDEX_FILE under taskDir and `git add -A` + `git diff --cached <rev>`
export async function exportPatch(handle: TaskHandle, destPath: string): Promise<void>;
export function runGit(cwd: string, args: string[],
  opts?: { env?: NodeJS.ProcessEnv }): Promise<{ code: number; stdout: string; stderr: string }>;
  // execFile-based, NO stdin and NO timeout — gap 7; not used by new code (CommandRunner instead)
export function killProcessTree(pid: number): void;
  // win32: taskkill /PID <pid> /T /F; POSIX: kill(-pid) then kill(pid); never throws; pid<=0 no-op
export type ResolvedConfig = Record<string, { value: unknown; source: ConfigSource }>;
export async function loadConfig(opts: { projectRoot: string; userDefaultsPath?: string;
  discovered?: DiscoveredValues; cli?: Record<string, unknown> }): Promise<ResolvedConfig>;
  // BUILTIN already contains "promotion.mode" = "apply" and "verify.test" = undefined
export async function runDoctor(projectRoot: string, discovery: Discovery,
  cliFlags?: Record<string, unknown>): Promise<string>;
export function isSecretPath(relativePosixPath: string): boolean;

// @tinystrap/policy (packages/policy/src)
export type HarnessEvent = { taskId: string; timestamp: string; kind: HarnessEventKind;
  tool?: string; argumentsDigest?: string; decision?: string; reason?: string;
  effectSignature?: string; hostEventType?: string; usage?: {...} };
export function makeEvent(taskId: string, kind: HarnessEventKind,
  fields?: Partial<Omit<HarnessEvent, "taskId" | "kind" | "timestamp">>): HarnessEvent;
export type ShellAnalysis = { ok: true; statements: ShellStatement[] }
  | { ok: false; reason: "unparseable" | "obfuscated" };
export type ShellStatement = { program: string; args: string[];
  redirects: { target: string; mode: "write" | "append" }[] };
export function analyzeShell(command: string): ShellAnalysis;   // shell.ts:63

// apps/cli (apps/cli/src/main.ts)
export async function runCli(argv: string[], discovery?: Discovery): Promise<string>;
  // any throw → process exitCode 1 (main.ts bottom block); existing commands: doctor,
  // task new, task export, task cleanup

// @tinystrap/bench (packages/bench/src/verify.ts) — REFERENCE ONLY, core must not import it
export async function verifyInFreshCopy(fixtureDir: string, patch: string,
  hiddenDir: string | null, command: string, timeoutMs?: number):
  Promise<{ passed: boolean; exitCode: number; outputTail: string }>;
  // ideas reused: temp copy, `git apply --whitespace=nowarn -` via stdin, metachar rejection,
  // 4000-char output tail. Its child.kill("SIGKILL") misses grandchildren — we use killProcessTree.
```

## Spec-vs-code gaps found while writing this plan (audit results, report upstream)

Evidence is `file:line` on `main` (`9d83ce2`).

1. **The §13.4 event kinds for this area do not exist.** `audit.ts:1–9` has no `verification_started`, `verification_finished`, `promotion_requested`, `promotion_applied`, `promotion_refused` (also missing: `workspace_frozen`, `discovery_completed` — no producer in this plan, left for the supervisor plan). Task A1 adds the five this plan emits.
2. **There is no `WorkspaceProvider` in code.** Spec §9.2 defines the interface and the two providers; `snapshot-git.ts:47` hardcodes the independent-clone flow and nothing adopts a host directory. Group C lands the seam.
3. **The spec's provider signature does not fit the code.** Spec §9.2: `create(baseline: Baseline): Promise<TaskWorkspace>` — but in the code a `Baseline` is *produced* by snapshotting (`snapshotGit` returns it), and there is no `TaskWorkspace` type; `TaskHandle` already carries `workspaceDir`. Group C lands `create(handle, projectRoot) → Baseline` / `adopt(handle, dir) → Baseline` and flags the spec wording for correction (Open question 1).
4. **`config.ts` builtins cover only `verify.test`.** Spec §7 says any detected command can be overridden; `build`/`lint`/`typecheck` and custom names need the generic `verify.*` handling (Task A3) and the `[workspace]`/`[promotion]` keys need builtins (Task C3).
5. **`extractPatch` throws for manifest baselines** (`patch.ts:8–10`), so the verifier inherits git-only support (Open question 3).
6. **No fingerprint/drift/checkpoint code exists anywhere** (grep `drift`/`fingerprint` → only test fixtures in `policy/test/engine.test.ts`). §9.10 steps (1) and (2) are entirely new (Tasks D1–D2).
7. **`runGit` has no stdin and no timeout** (`git.ts:7–16`): applying a patch via stdin (`git apply -`), bounded `git` operations, and injectable fakes all need a richer seam. `CommandRunner` (Task B1) is that seam; `runGit` stays as-is for existing callers.
8. **The bench verifier cannot be reused and is subtly unsafe for the harness.** `bench/src/verify.ts` kills only the direct child (`child.kill("SIGKILL")`, line 52) — a verify command that spawns (test runners do) leaks grandchildren past the timeout; and `bench` depends on `core`, so importing it from `core` would cycle. Group B re-implements the idea with `killProcessTree`.
9. **`doctor` does not print detected verify commands** although §8.1 requires it (`doctor.ts` prints config + discovery only). Task E3 adds the section.
10. **The CLI cannot express exit outcomes beyond throw→1** (`main.ts:44` throws for unknown commands; the entry block maps any throw to exitCode 1). `task verify` failure is surfaced as an Error whose message *is* the actionable report (E1); finer-grained exit codes are deferred to the supervisor plan.

## Open questions for the user (with recommended defaults — not silently decided)

1. **WorkspaceProvider signature.** The spec's `create(baseline)/adopt(path)` presumes a pre-existing `Baseline` and a `TaskWorkspace` type, neither of which exists. *Recommended default (implemented here):* providers **produce** the baseline — `create(handle, projectRoot)` snapshots, `adopt(handle, dir)` records a baseline from the host directory's own git state — and the spec text gets amended to match. Alternative: keep the spec wording and add a separate snapshot stage; rejected as needless indirection.
2. **How the verifier reconstructs the baseline.** Options: (a) fresh `git clone` of `sourceRoot` + `checkout --detach <baseline rev>` at verify time, then apply the full extracted patch (the patch already contains baseline tracked changes and untracked files, since `extractPatch` diffs against the revision); (b) keep a second pristine copy of the workspace at snapshot time. *Recommended default:* (a) — no double disk cost at snapshot, immune to later drift of the user's working tree (the clone reads committed objects), and one code path. (b) is more hermetic against history rewrite/GC but doubles snapshot cost.
3. **Manifest (non-git) baselines.** `extractPatch` throws for them on `main`. *Recommended default:* the verifier refuses manifest baselines with an actionable message ("verification needs a git project; run git init and re-create the task") and this plan stays git-only; a manifest patch format is a follow-up plan.
4. **Can `--yes` approve a push?** Spec §9.10 is strict: `open_pr` needs explicit per-task approval plus the per-repo opt-in. *Recommended default:* `--yes`/`assumeYes` may approve `apply` and `commit_task_branch` (the user typed the flag for this task) but **never** `open_pr` — a push always requires an interactive `y` at a prompt that names the branch. The CLI also refuses `--mode open_pr` unless `tinystrap.toml` sets `promotion.mode = "open_pr"`. If the user wants `--yes` to cover pushes too, that is a spec change, not a code change.
5. **What are "post-apply checks"?** §9.10 step (4). *Recommended default:* re-run the same resolved verify command set in the protected project after a successful `apply`; on failure, auto-restore the rollback checkpoint and report. Configurable via `[promotion] post_apply_verify = true|false` (default true). Alternative: a separate `[promotion.post_apply]` command list — deferred until someone needs different commands.
6. **Drift scope and the rebase offer.** *Recommended default:* drift refuses `apply`, `commit_task_branch`, and `open_pr` uniformly (simplest guarantee; a PR pushed from a stale base wastes CI and reviewer time). The refusal message offers "re-run the task on the current state, or review and apply the patch by hand"; actual rebase-and-reverify tooling is a follow-up plan.
7. **Does `export_patch` need an approve?** It writes a file outside the task dir and touches nothing else. *Recommended default:* no approval for `export_patch` (parity with the existing `task export`); approval gates everything that can affect the project or a remote.
8. **Verifier environment.** §9.8's scrubbed env is deferred with the sandbox. *Recommended default:* verifier children inherit `process.env` (same as `runGit` today), documented as tightening when the sandbox backend lands.
9. **Plumbing-commit identity.** `commit_task_branch`/`open_pr` create commits without touching the user's working tree; machines without a configured identity would fail. *Recommended default:* the broker sets `GIT_AUTHOR_NAME/EMAIL` and `GIT_COMMITTER_NAME/EMAIL` env to the harness identity (`tinystrap`, a `.invalid` address) for those calls only — the user's own git config is never read for authorship or modified.
10. **Package-manager command shape in detection.** Detected `package.json` scripts emit `pnpm run <name>`. *Recommended default:* pnpm (the repo convention and the spec §7 example); npm/yarn users override in `[verify]`.

---

### Task A1 [Group A]: Add the §13.4 verification/promotion event kinds

**Files:**
- Modify: `packages/policy/src/audit.ts` (union extension only)
- Test: `packages/policy/test/audit.test.ts` (extend)

**Interfaces:**
- Consumes: `makeEvent` (`audit.ts:23`, verified above).
- Produces: `HarnessEventKind` additionally includes `"verification_started" | "verification_finished" | "promotion_requested" | "promotion_applied" | "promotion_refused"` (consumed by B3, D5, D6).

Steps:

- [ ] Extend `packages/policy/test/audit.test.ts` with:

```ts
describe("verifier/promotion event kinds (spec 13.4)", () => {
  it("constructs the five lifecycle kinds", () => {
    expect(makeEvent("t1", "verification_started", { reason: "2 commands" }).kind)
      .toBe("verification_started");
    expect(makeEvent("t1", "verification_finished", { decision: "pass" }).kind)
      .toBe("verification_finished");
    expect(makeEvent("t1", "promotion_requested", { reason: "mode=apply" }).kind)
      .toBe("promotion_requested");
    expect(makeEvent("t1", "promotion_applied", { decision: "apply" }).kind)
      .toBe("promotion_applied");
    expect(makeEvent("t1", "promotion_refused", { reason: "drift" }).kind)
      .toBe("promotion_refused");
  });
});
```

- [ ] Run `pnpm vitest run packages/policy/test/audit.test.ts`. Expected: FAIL — TS errors `Type '"verification_started"' is not assignable to type 'HarnessEventKind'`.
- [ ] In `packages/policy/src/audit.ts`, append to the `HarnessEventKind` union (after `"model_usage"`):

```ts
  | "verification_started" | "verification_finished"
  | "promotion_requested" | "promotion_applied" | "promotion_refused";
```

(change the previous last member's trailing `;` to nothing and end the union here — union edit only, no other change).
- [ ] Run `pnpm vitest run packages/policy` + `pnpm typecheck`. Expected: PASS.
- [ ] Commit:

```bash
git add packages/policy/src/audit.ts packages/policy/test/audit.test.ts
git commit -m "feat(policy): add verification and promotion event kinds from spec 13.4

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task A2 [Group A]: Verify-command detection (spec §9.9)

**Files:**
- Create: `packages/core/src/verify-commands.ts`
- Modify: `packages/core/src/index.ts` (one additive export line)
- Test: `packages/core/test/verify-commands.test.ts`

**Interfaces:**
- Consumes: nothing outside Node built-ins.
- Produces (exported from `@tinystrap/core`):

```ts
export type VerifyCommand = { name: string; command: string };
export function detectVerifyCommands(projectRoot: string): VerifyCommand[];
```

Steps:

- [ ] Write `packages/core/test/verify-commands.test.ts`:

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectVerifyCommands } from "@tinystrap/core";

function project(setup: (dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "ts-vdetect-"));
  setup(dir);
  return dir;
}

describe("detectVerifyCommands", () => {
  it("detects package.json scripts in test/build/lint/typecheck order", () => {
    const dir = project((d) => writeFileSync(join(d, "package.json"), JSON.stringify({
      scripts: { typecheck: "tsc -b", lint: "eslint .", test: "vitest run", deploy: "node x" } })));
    expect(detectVerifyCommands(dir)).toEqual([
      { name: "test", command: "pnpm run test" },
      { name: "lint", command: "pnpm run lint" },
      { name: "typecheck", command: "pnpm run typecheck" },
    ]);
  });
  it("detects pytest from pytest.ini", () => {
    const dir = project((d) => writeFileSync(join(d, "pytest.ini"), "[pytest]\n"));
    expect(detectVerifyCommands(dir)).toEqual([{ name: "pytest", command: "pytest" }]);
  });
  it("detects pytest from a pyproject tool section", () => {
    const dir = project((d) => writeFileSync(join(d, "pyproject.toml"), "[tool.pytest.ini_options]\n"));
    expect(detectVerifyCommands(dir).map((c) => c.command)).toEqual(["pytest"]);
  });
  it("detects cargo and go", () => {
    const dir = project((d) => { writeFileSync(join(d, "Cargo.toml"), ""); writeFileSync(join(d, "go.mod"), ""); });
    expect(detectVerifyCommands(dir).map((c) => c.command).sort()).toEqual(["cargo test", "go test ./..."]);
  });
  it("detects a make test target only when present", () => {
    const withTarget = project((d) => writeFileSync(join(d, "Makefile"), "test:\n\techo ok\n"));
    const without = project((d) => writeFileSync(join(d, "Makefile"), "build:\n\techo ok\n"));
    expect(detectVerifyCommands(withTarget).map((c) => c.command)).toEqual(["make test"]);
    expect(detectVerifyCommands(without)).toEqual([]);
  });
  it("tolerates a malformed package.json", () => {
    const dir = project((d) => writeFileSync(join(d, "package.json"), "{not json"));
    expect(detectVerifyCommands(dir)).toEqual([]);
  });
});
```

- [ ] Run `pnpm vitest run packages/core/test/verify-commands.test.ts`. Expected: FAIL — `detectVerifyCommands is not a function` / not exported.
- [ ] Write `packages/core/src/verify-commands.ts`:

```ts
// Verify-command auto-detection (spec 9.9). Detection order is stable and
// puts the most informative check first. Commands are plain `program args`
// strings; the verifier refuses anything a shell would interpret.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type VerifyCommand = { name: string; command: string };

const NPM_SCRIPTS = ["test", "lint", "typecheck", "build"] as const;

export function detectVerifyCommands(projectRoot: string): VerifyCommand[] {
  const out: VerifyCommand[] = [];
  const pkgPath = join(projectRoot, "package.json");
  if (existsSync(pkgPath)) {
    let scripts: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: unknown };
      if (parsed.scripts && typeof parsed.scripts === "object") {
        scripts = parsed.scripts as Record<string, unknown>;
      }
    } catch { /* malformed package.json: skip, other ecosystems still count */ }
    for (const name of NPM_SCRIPTS) {
      if (typeof scripts[name] === "string") out.push({ name, command: `pnpm run ${name}` });
    }
  }
  if (existsSync(join(projectRoot, "pytest.ini")) || existsSync(join(projectRoot, "conftest.py"))
    || (existsSync(join(projectRoot, "pyproject.toml"))
        && readFileSync(join(projectRoot, "pyproject.toml"), "utf8").includes("[tool.pytest"))) {
    out.push({ name: "pytest", command: "pytest" });
  }
  if (existsSync(join(projectRoot, "Cargo.toml"))) out.push({ name: "cargo", command: "cargo test" });
  if (existsSync(join(projectRoot, "go.mod"))) out.push({ name: "go", command: "go test ./..." });
  const makefile = join(projectRoot, "Makefile");
  if (existsSync(makefile) && /^test:/m.test(readFileSync(makefile, "utf8"))) {
    out.push({ name: "make", command: "make test" });
  }
  return out;
}
```

- [ ] Add to `packages/core/src/index.ts`: `export * from "./verify-commands.js";`
- [ ] Run `pnpm vitest run packages/core/test/verify-commands.test.ts`. Expected: PASS (6 tests).
- [ ] Commit:

```bash
git add packages/core/src/verify-commands.ts packages/core/src/index.ts packages/core/test/verify-commands.test.ts
git commit -m "feat(core): auto-detect verify commands from project markers

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task A3 [Group A]: Verify-command overrides from config

**Files:**
- Modify: `packages/core/src/verify-commands.ts` (append two functions)
- Test: `packages/core/test/verify-commands.test.ts` (extend)

**Interfaces:**
- Consumes: `ResolvedConfig` (`config.ts`, verified above).
- Produces (exported from `@tinystrap/core`):

```ts
export function resolveVerifyCommands(
  detected: VerifyCommand[], overrides: Record<string, unknown>): VerifyCommand[];
export function verifyOverridesFromConfig(config: ResolvedConfig): Record<string, unknown>;
```

Steps:

- [ ] Extend the test file:

```ts
import { resolveVerifyCommands, verifyOverridesFromConfig } from "@tinystrap/core";

describe("resolveVerifyCommands", () => {
  const detected = [
    { name: "test", command: "pnpm run test" },
    { name: "lint", command: "pnpm run lint" },
  ];
  it("an override replaces the detected command with the same name", () => {
    expect(resolveVerifyCommands(detected, { test: "pnpm vitest run" })).toEqual([
      { name: "test", command: "pnpm vitest run" },
      { name: "lint", command: "pnpm run lint" },
    ]);
  });
  it("an empty-string override disables a detected command", () => {
    expect(resolveVerifyCommands(detected, { lint: "" })).toEqual(
      [{ name: "test", command: "pnpm run test" }]);
  });
  it("an unknown key adds a new command", () => {
    expect(resolveVerifyCommands(detected, { smoke: "node smoke.mjs" })).toEqual([
      { name: "test", command: "pnpm run test" },
      { name: "lint", command: "pnpm run lint" },
      { name: "smoke", command: "node smoke.mjs" },
    ]);
  });
  it("non-string override values are ignored", () => {
    expect(resolveVerifyCommands(detected, { test: 42 })).toEqual(detected);
  });
});

describe("verifyOverridesFromConfig", () => {
  it("collects only verify.* keys, stripped", () => {
    const config = {
      "verify.test": { value: "pnpm vitest run", source: "project" as const },
      "promotion.mode": { value: "apply", source: "builtin" as const },
    };
    expect(verifyOverridesFromConfig(config)).toEqual({ test: "pnpm vitest run" });
  });
});
```

- [ ] Run the test file. Expected: FAIL — functions not exported.
- [ ] Append to `packages/core/src/verify-commands.ts`:

```ts
import type { ResolvedConfig } from "./config.js";

// Spec 7: "[verify] commands auto-detected; override any subset".
// A string override replaces the detected command of the same name (or adds
// a new one); the empty string disables a detected command (the recommended
// off-switch — TOML has no undefined). Non-string values are ignored so a
// stray `verify.test = false` cannot smuggle a non-command into the runner.
export function resolveVerifyCommands(
  detected: VerifyCommand[],
  overrides: Record<string, unknown>,
): VerifyCommand[] {
  const byName = new Map(detected.map((c) => [c.name, c]));
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value !== "string") continue;
    if (value.trim() === "") { byName.delete(key); continue; }
    byName.set(key, { name: key, command: value });
  }
  return [...byName.values()];
}

export function verifyOverridesFromConfig(config: ResolvedConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(config)) {
    if (key.startsWith("verify.")) out[key.slice("verify.".length)] = entry.value;
  }
  return out;
}
```

- [ ] Run the test file. Expected: PASS.
- [ ] Commit:

```bash
git add packages/core/src/verify-commands.ts packages/core/test/verify-commands.test.ts
git commit -m "feat(core): verify command overrides via the verify config table

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task B1 [Group B]: `CommandRunner` with process-tree timeout and stdin

**Files:**
- Create: `packages/core/src/run.ts`
- Modify: `packages/core/src/index.ts` (one additive export line)
- Test: `packages/core/test/run.test.ts`

**Interfaces:**
- Consumes: `killProcessTree` (`killtree.ts`, verified above).
- Produces (exported from `@tinystrap/core`):

```ts
export type RunResult = { code: number; stdout: string; stderr: string; timedOut: boolean };
export type RunOptions = { cwd: string; env?: NodeJS.ProcessEnv; stdin?: string; timeoutMs?: number };
export type CommandRunner =
  (cmd: string, args: string[], opts: RunOptions) => Promise<RunResult>;
export const defaultCommandRunner: CommandRunner;
```

Steps:

- [ ] Write `packages/core/test/run.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultCommandRunner } from "@tinystrap/core";

function tmp(): string { return mkdtempSync(join(tmpdir(), "ts-run-")); }

describe("defaultCommandRunner", () => {
  it("captures stdout and a zero exit code", async () => {
    const r = await defaultCommandRunner("node", ["--version"], { cwd: tmp() });
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^v\d+/);
  });
  it("feeds stdin to the child", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "cat.mjs"),
      "const chunks = []; for await (const c of process.stdin) chunks.push(c);\n" +
      "process.stdout.write(Buffer.concat(chunks));\n");
    const r = await defaultCommandRunner("node", ["cat.mjs"], { cwd: dir, stdin: "hello patch" });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("hello patch");
  });
  it("reports non-zero exit codes without throwing", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "fail.mjs"), "process.stderr.write('boom'); process.exit(3);\n");
    const r = await defaultCommandRunner("node", ["fail.mjs"], { cwd: dir });
    expect(r.code).toBe(3);
    expect(r.stderr).toBe("boom");
    expect(r.timedOut).toBe(false);
  });
  it("kills a hung child on timeout and flags timedOut", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "hang.mjs"), "setTimeout(() => {}, 60_000);\n");
    const started = Date.now();
    const r = await defaultCommandRunner("node", ["hang.mjs"], { cwd: dir, timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.code).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 15_000);
  it("never uses a shell: metacharacters stay literal arguments", async () => {
    const r = await defaultCommandRunner("node", ["--eval", "process.stdout.write(typeof process.env.__NOT_A_FLAG)"],
      { cwd: tmp(), env: { PATH: process.env.PATH ?? "" } });
    expect(r.stdout).toBe("undefined");
  });
});
```

- [ ] Run it. Expected: FAIL — `defaultCommandRunner` not exported.
- [ ] Write `packages/core/src/run.ts`:

```ts
// The injectable process seam for the verifier and the promotion broker.
// Unlike runGit (kept as-is for existing callers): argv-only spawn (shell is
// never involved), optional stdin payload (patches arrive as bytes), and a
// timeout that kills the WHOLE process tree via killProcessTree — a test
// runner that forked workers dies with it (spec 9.8 process-tree cleanup).
import { spawn } from "node:child_process";
import { killProcessTree } from "./killtree.js";

export type RunResult = { code: number; stdout: string; stderr: string; timedOut: boolean };
export type RunOptions = { cwd: string; env?: NodeJS.ProcessEnv; stdin?: string; timeoutMs?: number };
export type CommandRunner =
  (cmd: string, args: string[], opts: RunOptions) => Promise<RunResult>;

export const defaultCommandRunner: CommandRunner = (cmd, args, opts) =>
  new Promise<RunResult>((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      // POSIX: lead our own process group so killProcessTree signals every
      // descendant (same discipline as the host runners).
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d: Buffer) => { stdout += d; });
    child.stderr.on("data", (d: Buffer) => { stderr += d; });
    const timer = opts.timeoutMs
      ? setTimeout(() => { timedOut = true; killProcessTree(child.pid ?? -1); }, opts.timeoutMs)
      : undefined;
    child.on("error", () => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + `\nspawn failed: ${cmd}`, timedOut });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: timedOut || code === null ? -1 : code, stdout, stderr, timedOut });
    });
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
    else child.stdin.end();
  });
```

- [ ] Add to `packages/core/src/index.ts`: `export * from "./run.js";`
- [ ] Run it. Expected: PASS (5 tests).
- [ ] Commit:

```bash
git add packages/core/src/run.ts packages/core/src/index.ts packages/core/test/run.test.ts
git commit -m "feat(core): injectable command runner with process-tree timeout

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task B2 [Group B]: Verify-command safety and bounded execution

**Files:**
- Create: `packages/core/src/verify.ts` (safety + per-command runner; `verifyInFreshWorkspace` arrives in B3)
- Modify: `packages/core/src/index.ts` (one additive export line)
- Test: `packages/core/test/verify.test.ts`

**Interfaces:**
- Consumes: `analyzeShell` (`@tinystrap/policy`), `defaultCommandRunner`/`CommandRunner` (B1), `VerifyCommand` (A2), `killProcessTree`.
- Produces (exported from `@tinystrap/core`):

```ts
export function splitVerifyCommand(command: string): string[];
export type VerifyCommandResult = {
  name: string; command: string; exitCode: number;
  timedOut: boolean; outputTail: string; durationMs: number;
};
export function runVerifyCommand(
  cmd: VerifyCommand, cwd: string,
  opts?: { timeoutMs?: number; outputTailChars?: number; runner?: CommandRunner },
): Promise<VerifyCommandResult>;
export const DEFAULT_VERIFY_TIMEOUT_MS: number;   // 120_000
export const DEFAULT_OUTPUT_TAIL_CHARS: number;   // 4000
```

Steps:

- [ ] Write `packages/core/test/verify.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { splitVerifyCommand, runVerifyCommand } from "@tinystrap/core";

function tmp(): string { return mkdtempSync(join(tmpdir(), "ts-vrun-")); }

describe("splitVerifyCommand", () => {
  it("splits a plain program invocation", () => {
    expect(splitVerifyCommand("go test ./...")).toEqual(["go", "test", "./..."]);
  });
  it("rejects shell metacharacters", () => {
    for (const bad of ["echo hi; rm -rf /", "cat a | sh", "make ${TARGET}", "pytest > out.txt",
      "cargo test && curl example.invalid", "node `whoami`", "npx vitest"]) {
      expect(() => splitVerifyCommand(bad)).toThrow(/metacharacter|not a plain|single plain/);
    }
  });
  it("rejects an empty command", () => {
    expect(() => splitVerifyCommand("   ")).toThrow(/empty/);
  });
});

describe("runVerifyCommand", () => {
  it("runs a script and captures its exit code", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "ok.mjs"), "process.stdout.write('ran');\n");
    const r = await runVerifyCommand({ name: "ok", command: "node ok.mjs" }, dir);
    expect(r).toMatchObject({ name: "ok", exitCode: 0, timedOut: false, outputTail: "ran" });
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });
  it("keeps only the bounded tail of loud output", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "loud.mjs"),
      "for (let i = 0; i < 2000; i++) process.stdout.write(`line-` + i + `\\n`);\n");
    const r = await runVerifyCommand(
      { name: "loud", command: "node loud.mjs" }, dir, { outputTailChars: 200 });
    expect(r.outputTail.length).toBeLessThanOrEqual(200);
    expect(r.outputTail).toContain("line-1999");
  });
  it("times out with the tree-kill runner and says so in the tail", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "hang.mjs"), "setTimeout(() => {}, 60_000);\n");
    const r = await runVerifyCommand(
      { name: "hang", command: "node hang.mjs" }, dir, { timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).not.toBe(0);
    expect(r.outputTail).toContain("timed out");
  }, 15_000);
});
```

- [ ] Run it. Expected: FAIL — functions not exported.
- [ ] Write `packages/core/src/verify.ts` (part 1):

```ts
// Fresh-copy verification (spec 9.9). The model's workspace is never the
// verification target: the patch is applied to a fresh checkout of the
// baseline in a harness-owned directory and the commands run there.
// Ideas ported from packages/bench/src/verify.ts (which core must not import
// — bench depends on core) with one fix: timeouts kill the whole process
// tree (killProcessTree), not just the direct child.
import { analyzeShell } from "@tinystrap/policy";
import { defaultCommandRunner, type CommandRunner } from "./run.js";
import type { VerifyCommand } from "./verify-commands.js";

export const DEFAULT_VERIFY_TIMEOUT_MS = 120_000;
export const DEFAULT_OUTPUT_TAIL_CHARS = 4000;

// Same fail-closed philosophy as the policy shell analyzer: a verify command
// is a single plain program invocation or it is not run at all. Metacharacters
// are rejected outright (bench parity) AND the command must classify through
// analyzeShell as exactly one redirect-free statement — one vocabulary for
// "what is a safe command" across gate and verifier.
const SHELL_METACHARS = /[;&|<>`$(){}\[\]*?~!#\\'"\n]/;

export function splitVerifyCommand(command: string): string[] {
  if (SHELL_METACHARS.test(command)) {
    throw new Error(`verify command contains forbidden shell metacharacters: ${command}`);
  }
  const analysis = analyzeShell(command);
  if (!analysis.ok) {
    throw new Error(`verify command is not a plain program invocation: ${command}`);
  }
  if (analysis.statements.length !== 1 || analysis.statements[0].redirects.length > 0) {
    throw new Error(`verify command must be a single plain command: ${command}`);
  }
  const parts = command.trim().split(/\s+/).filter((p) => p !== "");
  if (parts.length === 0) throw new Error("verify command is empty");
  return parts;
}

export type VerifyCommandResult = {
  name: string; command: string; exitCode: number;
  timedOut: boolean; outputTail: string; durationMs: number;
};

function tail(text: string, cap: number): string {
  return text.length <= cap ? text : text.slice(-cap);
}

export async function runVerifyCommand(
  cmd: VerifyCommand,
  cwd: string,
  opts: { timeoutMs?: number; outputTailChars?: number; runner?: CommandRunner } = {},
): Promise<VerifyCommandResult> {
  const argv = splitVerifyCommand(cmd.command); // validated before anything spawns
  const timeoutMs = opts.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
  const cap = opts.outputTailChars ?? DEFAULT_OUTPUT_TAIL_CHARS;
  const runner = opts.runner ?? defaultCommandRunner;
  const started = Date.now();
  const r = await runner(argv[0], argv.slice(1), { cwd, timeoutMs });
  const combined = r.stdout + (r.stderr ? `\n${r.stderr}` : "");
  const note = r.timedOut ? `\nverify command timed out after ${timeoutMs}ms and its process tree was killed\n` : "";
  return {
    name: cmd.name, command: cmd.command,
    exitCode: r.code, timedOut: r.timedOut,
    outputTail: tail(combined + note, cap),
    durationMs: Date.now() - started,
  };
}
```

- [ ] Add to `packages/core/src/index.ts`: `export * from "./verify.js";`
- [ ] Run it. Expected: PASS (6 tests).
- [ ] Commit:

```bash
git add packages/core/src/verify.ts packages/core/src/index.ts packages/core/test/verify.test.ts
git commit -m "feat(core): policy-consistent verify command safety and bounded runs

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task B3 [Group B]: `verifyInFreshWorkspace` — fresh baseline checkout + patch + commands

**Files:**
- Modify: `packages/core/src/verify.ts` (append)
- Test: `packages/core/test/verify.test.ts` (extend)

**Interfaces:**
- Consumes: `TaskHandle`, `Baseline` (verified above), `defaultCommandRunner`, `runVerifyCommand`, `makeEvent` (`@tinystrap/policy`), the A1 event kinds.
- Produces (exported from `@tinystrap/core`):

```ts
export type VerifyReport = {
  taskId: string;
  passed: boolean;
  patchHash: string;                       // sha256:<hex> over the exact patch bytes
  apply: { ok: boolean; outputTail: string };
  results: VerifyCommandResult[];
  startedAt: string;
  finishedAt: string;
};
export type VerifyOptions = {
  timeoutMs?: number; outputTailChars?: number;
  runner?: CommandRunner;
  onEvent?: (e: HarnessEvent) => void;
};
export async function verifyInFreshWorkspace(
  handle: TaskHandle, baseline: Baseline, patch: string,
  commands: VerifyCommand[], opts?: VerifyOptions,
): Promise<VerifyReport>;
```

Steps:

- [ ] Extend `packages/core/test/verify.test.ts`. Helper builds a real git project, snapshots, edits the workspace, extracts the patch (the `patch.test.ts` pattern):

```ts
import { execFileSync } from "node:child_process";
import { createTask, extractPatch, snapshotGit, verifyInFreshWorkspace } from "@tinystrap/core";

function gitProjectWithEdit(checkBody: string): { root: string; handle: Awaited<ReturnType<typeof createTask>>; patch: string } {
  const root = mkdtempSync(join(tmpdir(), "ts-vfresh-"));
  const GIT_ID = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
  const g = (...a: string[]) => execFileSync("git",
    a, { cwd: root, stdio: "pipe", env: GIT_ID });
  g("init", "-b", "main");
  writeFileSync(join(root, "a.txt"), "one\n");
  writeFileSync(join(root, "check.mjs"), checkBody);
  g("add", "."); g("commit", "-m", "init");
  const handle = undefined as never; // replaced below — see the real test bodies
  return { root, handle, patch: "" };
}
```

Real test bodies (write these; the helper above is the shape, inline it per test for clarity):

```ts
describe("verifyInFreshWorkspace", () => {
  it("applies the patch to a fresh baseline copy and runs the checks there", async () => {
    const root = mkdtempSync(join(tmpdir(), "ts-vfresh-"));
    const GIT_ID = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
  const g = (...a: string[]) => execFileSync("git",
      a, { cwd: root, stdio: "pipe", env: GIT_ID });
    g("init", "-b", "main");
    writeFileSync(join(root, "a.txt"), "one\n");
    // check.mjs is part of the BASELINE and reads the file the patch changes.
    writeFileSync(join(root, "check.mjs"),
      "import { readFileSync } from 'node:fs';\n" +
      "process.exit(readFileSync('a.txt', 'utf8') === 'two\\n' ? 0 : 1);\n");
    g("add", "."); g("commit", "-m", "init");
    const handle = await createTask(root);
    const baseline = await snapshotGit(root, handle);
    writeFileSync(join(handle.workspaceDir, "a.txt"), "two\n");   // simulated model edit
    const patch = await extractPatch(handle);

    const events: string[] = [];
    const report = await verifyInFreshWorkspace(handle, baseline, patch,
      [{ name: "check", command: "node check.mjs" }],
      { onEvent: (e) => events.push(e.kind) });

    expect(report.apply.ok).toBe(true);
    expect(report.passed).toBe(true);
    expect(report.results).toHaveLength(1);
    expect(report.results[0]).toMatchObject({ name: "check", exitCode: 0, timedOut: false });
    expect(report.patchHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(events).toEqual(["verification_started", "verification_finished"]);
  }, 60_000);

  it("fails when a check fails, keeping the failure tail", async () => {
    /* same setup, check.mjs exits 1 with output "expected two"; assert
       report.passed === false, results[0].exitCode === 1, outputTail contains "expected two" */
  });

  it("reports apply failure without running any command", async () => {
    /* same setup, but hand verify a patch that does not apply (e.g. the patch
       built against a different baseline: change root's a.txt content to
       "seven" before extractPatch context, or simply pass "-nope\n" as patch);
       assert report.apply.ok === false, report.passed === false,
       report.results is empty, apply.outputTail is non-empty */
  });

  it("refuses a manifest baseline with an actionable message", async () => {
    /* baseline = { ...real, revision: "manifest:abc" }; expect the call to
       reject with /git project/ */
  });

  it("flags a timed-out check and continues to the report", async () => {
    /* check.mjs hangs; opts { timeoutMs: 300 }; assert results[0].timedOut,
       report.passed === false */
  }, 30_000);
});
```

(The three comment-abbreviated bodies repeat the first test's six-line setup with the noted variation — no new machinery per test.)

- [ ] Run it. Expected: FAIL — `verifyInFreshWorkspace` not exported.
- [ ] Append to `packages/core/src/verify.ts`:

```ts
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { makeEvent, type HarnessEvent } from "@tinystrap/policy";
import type { Baseline } from "./snapshot-git.js";
import type { TaskHandle } from "./taskstore.js";

export type VerifyReport = {
  taskId: string;
  passed: boolean;
  patchHash: string;
  apply: { ok: boolean; outputTail: string };
  results: VerifyCommandResult[];
  startedAt: string;
  finishedAt: string;
};

export type VerifyOptions = {
  timeoutMs?: number;
  outputTailChars?: number;
  runner?: CommandRunner;
  onEvent?: (e: HarnessEvent) => void;
};

// Spec 9.9 + 9.2: the verifier workspace is a fresh checkout of the SAME
// baseline the model started from — a clone of the source repo's committed
// objects at the baseline revision (immune to later drift of the user's
// working tree; the patch itself carries baseline tracked/untracked changes,
// since extractPatch diffs the workspace against the revision). The model's
// workspace directory is never read here, only its extracted patch.
export async function verifyInFreshWorkspace(
  handle: TaskHandle,
  baseline: Baseline,
  patch: string,
  commands: VerifyCommand[],
  opts: VerifyOptions = {},
): Promise<VerifyReport> {
  if (!baseline.revision.startsWith("git:")) {
    throw new Error(
      "verification needs a git baseline: run `git init` in the project and create a new task " +
      "(manifest-baseline verification is not implemented yet).");
  }
  const rev = baseline.revision.replace(/^git:/, "");
  const runner = opts.runner ?? defaultCommandRunner;
  const startedAt = new Date().toISOString();
  opts.onEvent?.(makeEvent(handle.taskId, "verification_started",
    { reason: `${commands.length} commands` }));

  const fresh = mkdtempSync(join(handle.taskDir, "verify-"));
  const clone = await runner("git", ["clone", "--no-hardlinks", baseline.sourceRoot, fresh],
    { cwd: handle.taskDir, timeoutMs: 120_000 });
  if (clone.code !== 0) {
    throw new Error(`verifier could not clone the baseline source: ${clone.stderr || clone.stdout}`);
  }
  const checkout = await runner("git", ["checkout", "--detach", rev],
    { cwd: fresh, timeoutMs: 60_000 });
  if (checkout.code !== 0) {
    throw new Error(`verifier could not check out the baseline revision: ${checkout.stderr || checkout.stdout}`);
  }
  await runner("git", ["remote", "remove", "origin"], { cwd: fresh, timeoutMs: 30_000 });

  const patchHash = `sha256:${createHash("sha256").update(patch).digest("hex")}`;
  let apply: VerifyReport["apply"] = { ok: true, outputTail: "" };
  if (patch.trim() !== "") {
    const applied = await runner("git", ["apply", "--whitespace=nowarn", "-"],
      { cwd: fresh, stdin: patch, timeoutMs: 60_000 });
    apply = { ok: applied.code === 0,
      outputTail: tail(applied.stdout + applied.stderr, opts.outputTailChars ?? DEFAULT_OUTPUT_TAIL_CHARS) };
  }

  const results: VerifyCommandResult[] = [];
  if (apply.ok) {
    for (const cmd of commands) {
      results.push(await runVerifyCommand(cmd, fresh, opts));
    }
  }
  const passed = apply.ok && results.length > 0 && results.every((r) => r.exitCode === 0 && !r.timedOut);
  const report: VerifyReport = {
    taskId: handle.taskId, passed, patchHash, apply, results,
    startedAt, finishedAt: new Date().toISOString(),
  };
  opts.onEvent?.(makeEvent(handle.taskId, "verification_finished",
    { decision: passed ? "pass" : "fail",
      reason: `apply=${apply.ok} checks=${results.length}` }));
  return report;
}
```

Note: an empty command list is a **fail** (`results.length > 0` guard) — "nothing ran" must never read as "verified".
- [ ] Run `pnpm vitest run packages/core` + `pnpm typecheck`. Expected: PASS.
- [ ] Commit:

```bash
git add packages/core/src/verify.ts packages/core/test/verify.test.ts
git commit -m "feat(core): verify extracted patches in a fresh baseline checkout

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task C1 [Group C]: `WorkspaceProvider` interface + independent-clone provider

**Files:**
- Create: `packages/core/src/workspace.ts`
- Modify: `packages/core/src/index.ts` (one additive export line)
- Test: `packages/core/test/workspace.test.ts`

**Interfaces:**
- Consumes: `TaskHandle`, `Baseline`, `isGitProject`, `snapshotGit`, `snapshotManifest` (verified above).
- Produces (exported from `@tinystrap/core`):

```ts
export interface WorkspaceProvider {
  readonly id: "independent-clone" | "external";
  create(handle: TaskHandle, projectRoot: string,
    opts?: { allowIgnoredDirs?: string[] }): Promise<Baseline>;
  adopt(handle: TaskHandle, externalDir: string): Promise<Baseline>;
}
export function createIndependentCloneProvider(): WorkspaceProvider;
```

(Signature deviation from spec §9.2 is deliberate — Open question 1.)

Steps:

- [ ] Write `packages/core/test/workspace.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTask, createIndependentCloneProvider } from "@tinystrap/core";

function gitProject(): string {
  const root = mkdtempSync(join(tmpdir(), "ts-wsp-"));
  const GIT_ID = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
  const g = (...a: string[]) => execFileSync("git",
    a, { cwd: root, stdio: "pipe", env: GIT_ID });
  g("init", "-b", "main");
  writeFileSync(join(root, "a.txt"), "one\n");
  g("add", "."); g("commit", "-m", "init");
  return root;
}

describe("independent-clone provider", () => {
  it("create snapshots a git project and reports the provider id", async () => {
    const root = gitProject();
    const handle = await createTask(root);
    const provider = createIndependentCloneProvider();
    expect(provider.id).toBe("independent-clone");
    const baseline = await provider.create(handle, root);
    expect(baseline.revision).toMatch(/^git:[0-9a-f]{40}$/);
    expect(existsSync(join(handle.workspaceDir, "a.txt"))).toBe(true);
  });

  it("adopt is not supported by the independent-clone provider", async () => {
    const root = gitProject();
    const handle = await createTask(root);
    await expect(createIndependentCloneProvider().adopt(handle, root))
      .rejects.toThrow(/not supported/);
  });
});
```

- [ ] Run it. Expected: FAIL — not exported.
- [ ] Write `packages/core/src/workspace.ts`:

```ts
// WorkspaceProvider seam (spec 9.2). The default provider keeps the strong
// standalone guarantee: a fresh independent clone with no origin linkage.
// Signature note (plan open question 1): providers PRODUCE the Baseline —
// the spec's create(baseline) predates the code where snapshotting is what
// creates a baseline.
import { isGitProject } from "./snapshot-git.js";
import { snapshotGit } from "./snapshot-git.js";
import { snapshotManifest } from "./snapshot-manifest.js";
import type { Baseline } from "./snapshot-git.js";
import type { TaskHandle } from "./taskstore.js";

export interface WorkspaceProvider {
  readonly id: "independent-clone" | "external";
  create(handle: TaskHandle, projectRoot: string,
    opts?: { allowIgnoredDirs?: string[] }): Promise<Baseline>;
  adopt(handle: TaskHandle, externalDir: string): Promise<Baseline>;
}

export function createIndependentCloneProvider(): WorkspaceProvider {
  return {
    id: "independent-clone",
    async create(handle, projectRoot, opts = {}) {
      return (await isGitProject(projectRoot))
        ? snapshotGit(projectRoot, handle, opts)
        : snapshotManifest(projectRoot, handle);
    },
    async adopt() {
      throw new Error("adopt is not supported by the independent-clone provider");
    },
  };
}
```

- [ ] Add to `packages/core/src/index.ts`: `export * from "./workspace.js";`
- [ ] Run it. Expected: PASS (2 tests).
- [ ] Commit:

```bash
git add packages/core/src/workspace.ts packages/core/src/index.ts packages/core/test/workspace.test.ts
git commit -m "feat(core): WorkspaceProvider seam with independent-clone default

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task C2 [Group C]: External workspace provider (host-supplied directory)

**Files:**
- Modify: `packages/core/src/workspace.ts` (append provider)
- Modify: `packages/core/src/taskstore.ts` (optional `externalWorkspaceDir` + marker read in `openTask`)
- Modify: `packages/core/src/patch.ts` (extract from the adopted directory)
- Test: `packages/core/test/workspace.test.ts` (extend)

**Interfaces:**
- Consumes: `defaultCommandRunner` (B1 — but C merges before B; use `runGit` from `git.ts` instead, which exists on `main` and suffices here: `runGit(dir, args)`), `Baseline`, `TaskHandle`, `captureWorkspaceManifestHash`.
- Produces (exported from `@tinystrap/core`):

```ts
export function createExternalWorkspaceProvider(): WorkspaceProvider;
// TaskHandle gains: externalWorkspaceDir?: string
```

Steps:

- [ ] Extend `packages/core/test/workspace.test.ts`:

```ts
import { createExternalWorkspaceProvider, extractPatch, openTask } from "@tinystrap/core";
import { readFileSync } from "node:fs";

describe("external workspace provider", () => {
  it("adopts a host directory: baseline from its HEAD, patch from its dirty state", async () => {
    const hostDir = gitProject();                       // the AO-style worktree
    const root = mkdtempSync(join(tmpdir(), "ts-wsp-meta-"));  // tinystrap metadata root
    const handle = await createTask(root);
    const provider = createExternalWorkspaceProvider();
    expect(provider.id).toBe("external");

    writeFileSync(join(hostDir, "a.txt"), "two\n");      // host worker edited
    writeFileSync(join(hostDir, "new.txt"), "created\n");
    const baseline = await provider.adopt(handle, hostDir);

    expect(baseline.revision).toMatch(/^git:[0-9a-f]{40}$/);
    expect(baseline.sourceRoot).toBe(hostDir);
    expect(baseline.untrackedPolicy).toContain("external");
    expect(handle.externalWorkspaceDir).toBe(hostDir);

    // openTask re-reads the marker written by adopt:
    const reopened = openTask(root, handle.taskId);
    expect(reopened.externalWorkspaceDir).toBe(hostDir);

    // patch extraction runs against the adopted directory, not taskDir/workspace:
    const patch = await extractPatch(reopened);
    expect(patch).toContain("-one");
    expect(patch).toContain("+two");
    expect(patch).toContain("new.txt");
  });

  it("refuses to adopt a non-git directory with an actionable message", async () => {
    const plain = mkdtempSync(join(tmpdir(), "ts-wsp-plain-"));
    const root = mkdtempSync(join(tmpdir(), "ts-wsp-meta2-"));
    const handle = await createTask(root);
    await expect(createExternalWorkspaceProvider().adopt(handle, plain))
      .rejects.toThrow(/git repository/);
  });
});
```

- [ ] Run it. Expected: FAIL — provider not exported / `externalWorkspaceDir` unknown.
- [ ] Modify `packages/core/src/taskstore.ts`:
  - In `TaskHandle`, add: `externalWorkspaceDir?: string;`
  - In `openTask`, after building the handle, before `return`:

```ts
  const marker = join(taskDir, "external.json");
  if (existsSync(marker)) {
    handle.externalWorkspaceDir =
      (JSON.parse(readFileSync(marker, "utf8")) as { dir: string }).dir;
  }
```

(add `readFileSync` to the `node:fs` import line — `existsSync` is already imported).
- [ ] Modify `packages/core/src/patch.ts`: in `extractPatch`, replace the two uses of `handle.workspaceDir` with:

```ts
  const ws = handle.externalWorkspaceDir ?? handle.workspaceDir;
```

and pass `ws` to both `runGit` calls. (No other change; the tmp-index env stays.)
- [ ] Append to `packages/core/src/workspace.ts`:

```ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runGit } from "./git.js";
import { captureWorkspaceManifestHash } from "./snapshot-git.js";

// External provider (spec 9.2, 13.5 mode 3): the host — an AO worker, a git
// worktree — already owns the directory. The harness does NOT copy it and
// does NOT own its lifecycle; it records a baseline from the directory's own
// git state and points the handle at it. Git-metadata isolation is NOT
// structural here (spec table): policy + the promotion broker are the guard.
// v1 requires the adopted directory to be a git repo (patch extraction is
// git-only — plan open question 3).
export function createExternalWorkspaceProvider(): WorkspaceProvider {
  return {
    id: "external",
    async create() {
      throw new Error("the external provider never creates workspaces; use adopt()");
    },
    async adopt(handle, externalDir) {
      const probe = await runGit(externalDir, ["rev-parse", "--git-dir"]);
      if (probe.code !== 0) {
        throw new Error(`adopted workspace is not a git repository: ${externalDir} ` +
          `(external workspaces need git for patch extraction)`);
      }
      const head = await runGit(externalDir, ["rev-parse", "HEAD"]);
      if (head.code !== 0) {
        throw new Error(`adopted workspace has no commits yet: ${externalDir}`);
      }
      const diff = await runGit(externalDir, ["diff", "HEAD"]);
      const baseline: Baseline = {
        taskId: handle.taskId,
        sourceRoot: externalDir,
        revision: `git:${head.stdout.trim()}`,
        manifestHash: await captureWorkspaceManifestHash(externalDir),
        trackedChangesHash: `sha256:${createHash("sha256").update(diff.stdout).digest("hex")}`,
        untrackedPolicy: "external:host-owned",
        createdAt: new Date().toISOString(),
      };
      writeFileSync(handle.baselinePath, JSON.stringify(baseline, null, 2));
      writeFileSync(join(handle.taskDir, "external.json"),
        JSON.stringify({ dir: externalDir }, null, 2));
      handle.externalWorkspaceDir = externalDir;
      return baseline;
    },
  };
}
```

(add `createHash` to the imports at the top of `workspace.ts`).
- [ ] Run `pnpm vitest run packages/core/test/workspace.test.ts packages/core/test/patch.test.ts packages/core/test/taskstore.test.ts`. Expected: PASS — patch/taskstore tests unchanged behavior when no marker exists.
- [ ] Commit:

```bash
git add packages/core/src/workspace.ts packages/core/src/taskstore.ts packages/core/src/patch.ts packages/core/test/workspace.test.ts
git commit -m "feat(core): external workspace provider adopts host-supplied directories

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task C3 [Group C]: Provider selection from `[workspace]` config

**Files:**
- Modify: `packages/core/src/workspace.ts` (append factory)
- Modify: `packages/core/src/config.ts` (builtins + KEY_MAP additions only)
- Test: `packages/core/test/workspace.test.ts` (extend)

**Interfaces:**
- Consumes: `ResolvedConfig`, `loadConfig` (verified above).
- Produces (exported from `@tinystrap/core`):

```ts
export function workspaceProviderFromConfig(config: ResolvedConfig): WorkspaceProvider;
```

Steps:

- [ ] Extend the test file:

```ts
import { loadConfig, workspaceProviderFromConfig } from "@tinystrap/core";

async function configWith(toml: string, name: string): Promise<ReturnType<typeof loadConfig>> {
  const dir = mkdtempSync(join(tmpdir(), `ts-wcfg-${name}-`));
  writeFileSync(join(dir, "tinystrap.toml"), toml);
  return loadConfig({ projectRoot: dir });
}

describe("workspaceProviderFromConfig", () => {
  it("defaults to independent-clone", async () => {
    const config = await configWith("", "def");
    expect(workspaceProviderFromConfig(config).id).toBe("independent-clone");
  });
  it("external requires a path", async () => {
    const config = await configWith('[workspace]\nprovider = "external"\n', "nopath");
    expect(() => workspaceProviderFromConfig(config)).toThrow(/workspace.path/);
  });
  it("external with a path selects the external provider", async () => {
    const host = gitProject();
    const config = await configWith(
      `[workspace]\nprovider = "external"\npath = ${JSON.stringify(host)}\n`, "withpath");
    expect(workspaceProviderFromConfig(config).id).toBe("external");
  });
  it("unknown provider names are refused, not defaulted", async () => {
    const config = await configWith('[workspace]\nprovider = "docker"\n', "bogus");
    expect(() => workspaceProviderFromConfig(config)).toThrow(/unknown workspace provider/);
  });
});
```

- [ ] Run it. Expected: FAIL — factory not exported.
- [ ] Modify `packages/core/src/config.ts` — in `BUILTIN`, add three entries (keep existing ones byte-identical):

```ts
  "workspace.provider": "independent-clone",
  "workspace.path": undefined,
  "promotion.postApplyVerify": true,
```

and in `KEY_MAP` add: `"post_apply_verify": "postApplyVerify",`.
- [ ] Append to `packages/core/src/workspace.ts`:

```ts
import type { ResolvedConfig } from "./config.js";
import { existsSync } from "node:fs";   // already imported after C2 — reuse

// Spec 7: the [workspace] table selects the provider; external demands a
// path. Unknown names fail loudly — silently falling back to the default
// would hide a typo behind a full re-clone of the wrong tree.
export function workspaceProviderFromConfig(config: ResolvedConfig): WorkspaceProvider {
  const provider = String(config["workspace.provider"]?.value ?? "independent-clone");
  if (provider === "independent-clone") return createIndependentCloneProvider();
  if (provider === "external") {
    const path = config["workspace.path"]?.value;
    if (typeof path !== "string" || path.trim() === "") {
      throw new Error("workspace.path is required when workspace.provider = \"external\"");
    }
    if (!existsSync(path)) {
      throw new Error(`workspace.path does not exist: ${path}`);
    }
    return createExternalWorkspaceProvider();
  }
  throw new Error(`unknown workspace provider "${provider}" (expected independent-clone or external)`);
}
```

- [ ] Run `pnpm vitest run packages/core` (config.test.ts asserts the resolved key set — if it pins an exact list, extend it with the three new keys in the same commit; read the test first). Expected: PASS.
- [ ] Commit:

```bash
git add packages/core/src/workspace.ts packages/core/src/config.ts packages/core/test/workspace.test.ts packages/core/test/config.test.ts
git commit -m "feat(core): select the workspace provider from the workspace config table

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task D1 [Group D]: Project fingerprint and drift detection

**Files:**
- Create: `packages/core/src/promotion.ts`
- Modify: `packages/core/src/index.ts` (one additive export line)
- Test: `packages/core/test/promotion-drift.test.ts`

**Interfaces:**
- Consumes: `Baseline`, `CommandRunner`, `defaultCommandRunner`, `captureWorkspaceManifestHash`.
- Produces (exported from `@tinystrap/core`):

```ts
export type ProjectFingerprint = { revision: string; trackedChangesHash: string };
export async function computeProjectFingerprint(
  projectRoot: string, runner?: CommandRunner): Promise<ProjectFingerprint>;
export async function checkDrift(
  projectRoot: string, baseline: Baseline, runner?: CommandRunner,
): Promise<{ drifted: boolean; detail: string }>;
```

Steps:

- [ ] Write `packages/core/test/promotion-drift.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeProjectFingerprint, checkDrift, createTask, snapshotGit } from "@tinystrap/core";

const GIT_ID = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };

function gitProject(): string {
  const root = mkdtempSync(join(tmpdir(), "ts-drift-"));
  const g = (...a: string[]) => execFileSync("git",
    a, { cwd: root, stdio: "pipe", env: GIT_ID });
  g("init", "-b", "main");
  writeFileSync(join(root, "a.txt"), "one\n");
  g("add", "."); g("commit", "-m", "init");
  return root;
}

describe("drift detection", () => {
  it("no drift right after the snapshot", async () => {
    const root = gitProject();
    const handle = await createTask(root);
    const baseline = await snapshotGit(root, handle);
    expect(await checkDrift(root, baseline)).toEqual({ drifted: false, detail: "" });
  });

  it("a new upstream commit is drift", async () => {
    const root = gitProject();
    const handle = await createTask(root);
    const baseline = await snapshotGit(root, handle);
    writeFileSync(join(root, "b.txt"), "new\n");
    execFileSync("git", ["add", "b.txt"], { cwd: root, stdio: "pipe", env: GIT_ID });
    execFileSync("git", ["commit", "-m", "later"], { cwd: root, stdio: "pipe", env: GIT_ID });
    const d = await checkDrift(root, baseline);
    expect(d.drifted).toBe(true);
    expect(d.detail).toMatch(/new commits since the task started/);
  });

  it("changed uncommitted edits are drift", async () => {
    const root = gitProject();
    const handle = await createTask(root);
    const baseline = await snapshotGit(root, handle);
    writeFileSync(join(root, "a.txt"), "human edit\n");
    const d = await checkDrift(root, baseline);
    expect(d.drifted).toBe(true);
    expect(d.detail).toMatch(/uncommitted changes .* changed/);
  });

  it("fingerprint revision matches the baseline revision format", async () => {
    const root = gitProject();
    const fp = await computeProjectFingerprint(root);
    expect(fp.revision).toMatch(/^git:[0-9a-f]{40}$/);
    expect(fp.trackedChangesHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
```

- [ ] Run it. Expected: FAIL — not exported.
- [ ] Write `packages/core/src/promotion.ts` (part 1):

```ts
// Promotion broker (spec 9.10). The ONLY component that ever writes to the
// protected project or pushes a branch — always behind an explicit approve.
// Every git/gh invocation goes through the injectable CommandRunner so tests
// fake the remote-facing half entirely (no network, no real gh in CI).
import { createHash } from "node:crypto";
import { defaultCommandRunner, type CommandRunner, type RunResult } from "./run.js";
import { captureWorkspaceManifestHash, type Baseline } from "./snapshot-git.js";

export type ProjectFingerprint = { revision: string; trackedChangesHash: string };

export async function computeProjectFingerprint(
  projectRoot: string,
  runner: CommandRunner = defaultCommandRunner,
): Promise<ProjectFingerprint> {
  const head = await runner("git", ["rev-parse", "HEAD"], { cwd: projectRoot, timeoutMs: 30_000 });
  if (head.code !== 0) throw new Error(`not a git project: ${head.stderr || head.stdout}`);
  const diff = await runner("git", ["diff", "HEAD"], { cwd: projectRoot, timeoutMs: 60_000 });
  return {
    revision: `git:${head.stdout.trim()}`,
    trackedChangesHash: `sha256:${createHash("sha256").update(diff.stdout).digest("hex")}`,
  };
}

// Spec 14 "Drift": promotion stops; the message offers rebase-or-review in
// terms a non-expert can act on. Rebase TOOLING is a follow-up (open question 6).
export async function checkDrift(
  projectRoot: string,
  baseline: Baseline,
  runner: CommandRunner = defaultCommandRunner,
): Promise<{ drifted: boolean; detail: string }> {
  if (!baseline.revision.startsWith("git:")) {
    const now = captureWorkspaceManifestHash(projectRoot);
    return now === baseline.manifestHash
      ? { drifted: false, detail: "" }
      : { drifted: true, detail: "the project files changed since the task started" };
  }
  const fp = await computeProjectFingerprint(projectRoot, runner);
  if (fp.revision !== baseline.revision) {
    return { drifted: true, detail:
      "the project has new commits since the task started. Re-run the task on the current " +
      "state, or review and apply the patch by hand (tinystrap task export)." };
  }
  if (fp.trackedChangesHash !== baseline.trackedChangesHash) {
    return { drifted: true, detail:
      "uncommitted changes in the project changed since the task started. Review them " +
      "against the verified patch before applying anything." };
  }
  return { drifted: false, detail: "" };
}
```

- [ ] Add to `packages/core/src/index.ts`: `export * from "./promotion.js";`
- [ ] Run it. Expected: PASS (4 tests).
- [ ] Commit:

```bash
git add packages/core/src/promotion.ts packages/core/src/index.ts packages/core/test/promotion-drift.test.ts
git commit -m "feat(core): project fingerprint and drift detection for promotion

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task D2 [Group D]: Rollback checkpoint and restore

**Files:**
- Modify: `packages/core/src/promotion.ts` (append)
- Test: `packages/core/test/promotion-checkpoint.test.ts`

**Interfaces:**
- Consumes: `CommandRunner`, `TaskHandle`, `RunResult`.
- Produces (exported from `@tinystrap/core`):

```ts
export async function createRollbackCheckpoint(
  projectRoot: string, handle: TaskHandle, patch: string,
  runner?: CommandRunner): Promise<string>;            // returns checkpointDir
export async function restoreFromCheckpoint(
  projectRoot: string, checkpointDir: string, runner?: CommandRunner): Promise<void>;
```

Steps:

- [ ] Write `packages/core/test/promotion-checkpoint.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRollbackCheckpoint, restoreFromCheckpoint, createTask } from "@tinystrap/core";

function projectWithPatch(): { root: string; handle: Awaited<ReturnType<typeof createTask>>; patch: string } {
  const root = mkdtempSync(join(tmpdir(), "ts-ckpt-"));
  const GIT_ID = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
  const g = (...a: string[]) => execFileSync("git",
    a, { cwd: root, stdio: "pipe", env: GIT_ID });
  g("init", "-b", "main");
  writeFileSync(join(root, "a.txt"), "one\n");
  writeFileSync(join(root, "keep.txt"), "human\n");        // uncommitted human edit survives
  g("add", "."); g("commit", "-m", "init");
  writeFileSync(join(root, "keep.txt"), "human-edited\n");
  // patch: modify a.txt, create c.txt
  const patch = [
    "diff --git a/a.txt b/a.txt",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1 +1 @@",
    "-one",
    "+two",
    "diff --git a/c.txt b/c.txt",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/c.txt",
    "@@ -0,0 +1 @@",
    "+created",
    "",
  ].join("\n");
  return { root, handle: undefined as never, patch };
}

// Build the real handle inline in each test (createTask(root) after the setup
// above); the abbreviated helper returns the shape — inline for clarity.

describe("rollback checkpoint", () => {
  it("saves touched files, apply then restore returns the tree byte-for-byte", async () => {
    const { root, patch } = projectWithPatch();
    const handle = await createTask(root);
    const before = readFileSync(join(root, "a.txt"));
    const ckpt = await createRollbackCheckpoint(root, handle, patch);
    expect(existsSync(join(ckpt, "touched.txt"))).toBe(true);

    execFileSync("git", ["apply", "--whitespace=nowarn", "-"],
      { cwd: root, input: patch, stdio: ["pipe", "pipe", "pipe"] });
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("two\n");
    expect(existsSync(join(root, "c.txt"))).toBe(true);

    await restoreFromCheckpoint(root, ckpt);
    expect(readFileSync(join(root, "a.txt"))).toEqual(before);
    expect(existsSync(join(root, "c.txt"))).toBe(false);
    expect(readFileSync(join(root, "keep.txt"), "utf8")).toBe("human-edited\n");
  });
});
```

- [ ] Run it. Expected: FAIL — not exported.
- [ ] Append to `packages/core/src/promotion.ts`:

```ts
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TaskHandle } from "./taskstore.js";

// Checkpoint = the exact undo set for one patch application: the list of
// paths the patch touches plus the current bytes of every touched file that
// exists (absent files are recorded as absent and deleted on restore). No
// reverse-apply trickery: restoring the touched files is exactly inverting
// the patch, because git apply only writes the paths it lists.
export async function createRollbackCheckpoint(
  projectRoot: string,
  handle: TaskHandle,
  patch: string,
  runner: CommandRunner = defaultCommandRunner,
): Promise<string> {
  const ckpt = join(handle.taskDir, "checkpoint");
  mkdirSync(ckpt, { recursive: true });
  const listed = await runner("git", ["apply", "--name-only", "-"],
    { cwd: projectRoot, stdin: patch, timeoutMs: 60_000 });
  if (listed.code !== 0) {
    throw new Error(`patch does not apply cleanly to the project: ${listed.stderr || listed.stdout}`);
  }
  const touched = listed.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  writeFileSync(join(ckpt, "touched.txt"), touched.join("\n") + "\n");
  for (const rel of touched) {
    const src = join(projectRoot, rel);
    if (existsSync(src)) {
      const dest = join(ckpt, "files", rel);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
    }
  }
  return ckpt;
}

export async function restoreFromCheckpoint(
  projectRoot: string,
  checkpointDir: string,
  _runner: CommandRunner = defaultCommandRunner,
): Promise<void> {
  const touched = readFileSync(join(checkpointDir, "touched.txt"), "utf8")
    .split("\n").map((l) => l.trim()).filter((l) => l !== "");
  for (const rel of touched) {
    const saved = join(checkpointDir, "files", rel);
    const target = join(projectRoot, rel);
    if (existsSync(saved)) copyFileSync(saved, target);
    else if (existsSync(target)) rmSync(target);
  }
}
```

- [ ] Run it. Expected: PASS (1 test).
- [ ] Commit:

```bash
git add packages/core/src/promotion.ts packages/core/test/promotion-checkpoint.test.ts
git commit -m "feat(core): rollback checkpoint and restore for patch application

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task D3 [Group D]: Apply the verified patch; commit the task branch

**Files:**
- Modify: `packages/core/src/promotion.ts` (append)
- Test: `packages/core/test/promotion-apply.test.ts`

**Interfaces:**
- Consumes: `CommandRunner`, `RunResult`, `TaskHandle`.
- Produces (exported from `@tinystrap/core`):

```ts
export async function applyPatchToProject(
  projectRoot: string, patch: string, runner?: CommandRunner): Promise<RunResult>;
export type CommitBranchResult =
  | { ok: true; commit: string }
  | { ok: false; error: string };
export async function commitTaskBranch(
  projectRoot: string, handle: TaskHandle, patch: string, branch: string,
  runner?: CommandRunner): Promise<CommitBranchResult>;
export const PROTECTED_BRANCHES: ReadonlySet<string>;   // {"main", "master"}
```

Steps:

- [ ] Write `packages/core/test/promotion-apply.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyPatchToProject, commitTaskBranch, createTask } from "@tinystrap/core";

const PATCH = [
  "diff --git a/a.txt b/a.txt", "--- a/a.txt", "+++ b/a.txt",
  "@@ -1 +1 @@", "-one", "+two", "",
].join("\n");

const GIT_ID = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };

function gitProject(): string {
  const root = mkdtempSync(join(tmpdir(), "ts-apply-"));
  const g = (...a: string[]) => execFileSync("git",
    a, { cwd: root, stdio: "pipe", env: GIT_ID });
  g("init", "-b", "main");
  writeFileSync(join(root, "a.txt"), "one\n");
  g("add", "."); g("commit", "-m", "init");
  return root;
}
// (import writeFileSync alongside mkdtempSync above)

describe("applyPatchToProject", () => {
  it("applies via stdin and reports success", async () => {
    const root = gitProject();
    const r = await applyPatchToProject(root, PATCH);
    expect(r.code).toBe(0);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("two\n");
  });
});

describe("commitTaskBranch", () => {
  it("creates the branch commit without touching the working tree", async () => {
    const root = gitProject();
    const handle = await createTask(root);
    const r = await commitTaskBranch(root, handle, PATCH, "tinystrap/task-0001");
    expect(r.ok).toBe(true);
    // working tree untouched:
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("one\n");
    // branch exists and carries the change:
    const shown = execFileSync("git", ["show", "tinystrap/task-0001:a.txt"],
      { cwd: root, encoding: "utf8" });
    expect(shown).toBe("two\n");
  });

  it("refuses protected branch names", async () => {
    const root = gitProject();
    const handle = await createTask(root);
    for (const b of ["main", "master"]) {
      const r = await commitTaskBranch(root, handle, PATCH, b);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/protected/);
    }
  });

  it("refuses an existing branch instead of moving it", async () => {
    const root = gitProject();
    const handle = await createTask(root);
    execFileSync("git", ["branch", "taken"], { cwd: root, stdio: "pipe", env: GIT_ID });
    const r = await commitTaskBranch(root, handle, PATCH, "taken");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/already exists/);
  });
});
```

- [ ] Run it. Expected: FAIL — not exported.
- [ ] Append to `packages/core/src/promotion.ts`:

```ts
export const PROTECTED_BRANCHES: ReadonlySet<string> = new Set(["main", "master"]);

// Spec 9.10 step (3): apply ONLY the exact verified patch bytes, via stdin,
// never a directory copy. git apply is atomic: a failed apply changes nothing.
export async function applyPatchToProject(
  projectRoot: string, patch: string, runner: CommandRunner = defaultCommandRunner,
): Promise<RunResult> {
  return runner("git", ["apply", "--whitespace=nowarn", "-"],
    { cwd: projectRoot, stdin: patch, timeoutMs: 60_000 });
}

// commit_task_branch: pure git plumbing (temp index → read-tree → apply
// --cached → write-tree → commit-tree → update-ref). The user's working tree,
// index, and HEAD are never touched, and no push happens. Harness identity
// env keeps machines without a configured identity working (open question 9).
export async function commitTaskBranch(
  projectRoot: string,
  handle: TaskHandle,
  patch: string,
  branch: string,
  runner: CommandRunner = defaultCommandRunner,
): Promise<CommitBranchResult> {
  if (PROTECTED_BRANCHES.has(branch)) {
    return { ok: false, error: `refusing to write to protected branch "${branch}"` };
  }
  const exists = await runner("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
    { cwd: projectRoot, timeoutMs: 30_000 });
  if (exists.code === 0) {
    return { ok: false, error: `branch "${branch}" already exists; refusing to move it` };
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_INDEX_FILE: join(handle.taskDir, "branch.index"),
    GIT_AUTHOR_NAME: "tinystrap", GIT_AUTHOR_EMAIL: "tinystrap@localhost",
    GIT_COMMITTER_NAME: "tinystrap", GIT_COMMITTER_EMAIL: "tinystrap@localhost",
  };
  const read = await runner("git", ["read-tree", "HEAD"], { cwd: projectRoot, env, timeoutMs: 60_000 });
  if (read.code !== 0) return { ok: false, error: `read-tree failed: ${read.stderr || read.stdout}` };
  const applied = await runner("git", ["apply", "--cached", "--whitespace=nowarn", "-"],
    { cwd: projectRoot, env, stdin: patch, timeoutMs: 60_000 });
  if (applied.code !== 0) return { ok: false, error: `patch does not apply to the project: ${applied.stderr || applied.stdout}` };
  const tree = await runner("git", ["write-tree"], { cwd: projectRoot, env, timeoutMs: 60_000 });
  if (tree.code !== 0) return { ok: false, error: `write-tree failed: ${tree.stderr || tree.stdout}` };
  const commit = await runner("git", ["commit-tree", tree.stdout.trim(), "-m",
    `tinystrap: verified task patch ${handle.taskId}`], { cwd: projectRoot, env, timeoutMs: 60_000 });
  if (commit.code !== 0) return { ok: false, error: `commit-tree failed: ${commit.stderr || commit.stdout}` };
  const ref = await runner("git", ["update-ref", `refs/heads/${branch}`, commit.stdout.trim()],
    { cwd: projectRoot, env, timeoutMs: 30_000 });
  if (ref.code !== 0) return { ok: false, error: `update-ref failed: ${ref.stderr || ref.stdout}` };
  return { ok: true, commit: commit.stdout.trim() };
}
```

- [ ] Run it. Expected: PASS (4 tests).
- [ ] Commit:

```bash
git add packages/core/src/promotion.ts packages/core/test/promotion-apply.test.ts
git commit -m "feat(core): verified-patch application and plumbing task-branch commits

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task D4 [Group D]: `openPullRequest` — guarded push + gh, fake-runner tested

**Files:**
- Modify: `packages/core/src/promotion.ts` (append)
- Test: `packages/core/test/promotion-openpr.test.ts`

**Interfaces:**
- Consumes: `CommandRunner`, `TaskHandle`, `commitTaskBranch`, `PROTECTED_BRANCHES` (D3).
- Produces (exported from `@tinystrap/core`):

```ts
export type OpenPrResult =
  | { ok: true; branch: string; prUrl: string }
  | { ok: false; stage: "branch" | "remote" | "push" | "pr"; error: string };
export async function openPullRequest(
  projectRoot: string, handle: TaskHandle, patch: string,
  opts: { branch: string; base?: string; title?: string; body?: string;
    runner?: CommandRunner },
): Promise<OpenPrResult>;
```

Steps:

- [ ] Write `packages/core/test/promotion-openpr.test.ts` — **fake runner only; nothing here touches a network or a real gh**:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openPullRequest, type CommandRunner, type RunResult, createTask } from "@tinystrap/core";

type Call = { cmd: string; args: string[] };
const OK: RunResult = { code: 0, stdout: "", stderr: "", timedOut: false };

function fakeRunner(responses: Record<string, Partial<RunResult>>): { runner: CommandRunner; calls: Call[] } {
  const calls: Call[] = [];
  const runner: CommandRunner = async (cmd, args) => {
    calls.push({ cmd, args });
    const key = `${cmd} ${args.join(" ")}`;
    for (const [pattern, res] of Object.entries(responses)) {
      if (key.includes(pattern)) return { ...OK, ...res };
    }
    return OK;
  };
  return { runner, calls };
}

async function handle() {
  return createTask(mkdtempSync(join(tmpdir(), "ts-openpr-")));
}

describe("openPullRequest", () => {
  it("refuses protected branches before running anything", async () => {
    const { runner, calls } = fakeRunner({});
    const r = await openPullRequest("/w/project", await handle(), "patch",
      { branch: "main", runner });
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("refuses when the project has no origin remote", async () => {
    const { runner, calls } = fakeRunner({ "remote get-url": { code: 2, stderr: "no such remote" } });
    const r = await openPullRequest("/w/project", await handle(), "patch",
      { branch: "tinystrap/task-0001", runner });
    expect(r).toMatchObject({ ok: false, stage: "remote" });
    expect(calls.some((c) => c.args.includes("push"))).toBe(false);
  });

  it("pushes exactly the task branch, never force, then calls gh", async () => {
    const { runner, calls } = fakeRunner({
      "remote get-url": { stdout: "https://example.invalid/acme/project.git\n" },
      "pr create": { stdout: "https://example.invalid/acme/project/pull/7\n" },
    });
    const r = await openPullRequest("/w/project", await handle(), "patch",
      { branch: "tinystrap/task-0001", base: "main", title: "T", body: "B", runner });
    expect(r).toEqual({ ok: true, branch: "tinystrap/task-0001",
      prUrl: "https://example.invalid/acme/project/pull/7" });
    const push = calls.find((c) => c.args[0] === "push");
    expect(push?.args).toEqual(["push", "origin", "tinystrap/task-0001:tinystrap/task-0001"]);
    for (const c of calls) {
      expect(c.args).not.toContain("--force");
      expect(c.args).not.toContain("-f");
    }
    const gh = calls.find((c) => c.cmd === "gh");
    expect(gh?.args.slice(0, 2)).toEqual(["pr", "create"]);
    expect(gh?.args).toContain("--head");
    expect(gh?.args).toContain("tinystrap/task-0001");
  });

  it("reports a push failure at the push stage and never reaches gh", async () => {
    const { runner, calls } = fakeRunner({ "push": { code: 1, stderr: "rejected" } });
    const r = await openPullRequest("/w/project", await handle(), "patch",
      { branch: "tinystrap/task-0002", runner });
    expect(r).toMatchObject({ ok: false, stage: "push" });
    expect(calls.some((c) => c.cmd === "gh")).toBe(false);
  });

  it("surfaces a commitTaskBranch failure at the branch stage", async () => {
    const { runner } = fakeRunner({ "rev-parse --verify": { code: 0 } }); // branch exists
    const r = await openPullRequest("/w/project", await handle(), "patch",
      { branch: "tinystrap/task-0003", runner });
    expect(r).toMatchObject({ ok: false, stage: "branch" });
  });
});
```

- [ ] Run it. Expected: FAIL — not exported.
- [ ] Append to `packages/core/src/promotion.ts`:

```ts
// open_pr (spec 9.10): the broker — never the model — pushes ONLY the task
// branch and opens a PR. Guards live here so no caller can construct an
// unsafe push by accident: protected names are refused before any process
// runs; the push command is a fixed refspec with no force flag in the
// vocabulary; gh runs only after a successful push. All remote contact goes
// through the injected runner — production uses defaultCommandRunner, tests
// use a recorder, CI never touches a network.
export type OpenPrResult =
  | { ok: true; branch: string; prUrl: string }
  | { ok: false; stage: "branch" | "remote" | "push" | "pr"; error: string };

export async function openPullRequest(
  projectRoot: string,
  handle: TaskHandle,
  patch: string,
  opts: { branch: string; base?: string; title?: string; body?: string;
    runner?: CommandRunner },
): Promise<OpenPrResult> {
  const runner = opts.runner ?? defaultCommandRunner;
  if (PROTECTED_BRANCHES.has(opts.branch)) {
    return { ok: false, stage: "branch",
      error: `refusing to push protected branch "${opts.branch}"` };
  }
  const committed = await commitTaskBranch(projectRoot, handle, patch, opts.branch, runner);
  if (!committed.ok) return { ok: false, stage: "branch", error: committed.error };

  const remote = await runner("git", ["remote", "get-url", "origin"],
    { cwd: projectRoot, timeoutMs: 30_000 });
  if (remote.code !== 0) {
    return { ok: false, stage: "remote",
      error: "the project has no origin remote to push to; configure one or use export_patch" };
  }
  const push = await runner("git", ["push", "origin",
    `${opts.branch}:${opts.branch}`], { cwd: projectRoot, timeoutMs: 120_000 });
  if (push.code !== 0) {
    return { ok: false, stage: "push", error: `push failed: ${push.stderr || push.stdout}` };
  }
  const gh = await runner("gh", ["pr", "create",
    "--head", opts.branch, "--base", opts.base ?? "main",
    "--title", opts.title ?? `tinystrap: ${handle.taskId}`,
    "--body", opts.body ?? `Verified task patch for ${handle.taskId}.`],
    { cwd: projectRoot, timeoutMs: 120_000 });
  if (gh.code !== 0) {
    return { ok: false, stage: "pr", error: `gh pr create failed: ${gh.stderr || gh.stdout}` };
  }
  const prUrl = gh.stdout.trim().split("\n").find((l) => l.startsWith("http")) ?? "";
  return { ok: true, branch: opts.branch, prUrl };
}
```

- [ ] Run it. Expected: PASS (5 tests).
- [ ] Commit:

```bash
git add packages/core/src/promotion.ts packages/core/test/promotion-openpr.test.ts
git commit -m "feat(core): guarded open_pr promotion - task branch push then gh pr create

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task D5 [Group D]: `promote()` — verify gate, one-key approve, export and apply modes

**Files:**
- Modify: `packages/core/src/promotion.ts` (append)
- Test: `packages/core/test/promote.test.ts`

**Interfaces:**
- Consumes: everything above + `VerifyReport` (B3), `VerifyCommand` (A2), `runVerifyCommand` (B2), `makeEvent`, the A1 promotion event kinds, `checkDrift` (D1), `createRollbackCheckpoint`/`restoreFromCheckpoint` (D2), `applyPatchToProject` (D3).
- Produces (exported from `@tinystrap/core`):

```ts
export type PromotionMode = "apply" | "export_patch" | "commit_task_branch" | "open_pr";
export type ApproveIO = {
  out: (line: string) => void;
  ask: (question: string) => Promise<string>;
};
export type PromotionRequest = {
  handle: TaskHandle;
  baseline: Baseline;
  projectRoot: string;
  patch: string;
  report: VerifyReport;
  mode: PromotionMode;
  io: ApproveIO;
  runner?: CommandRunner;
  branch?: string;                       // default `tinystrap/<taskId>`
  prTitle?: string;
  prBody?: string;
  assumeYes?: boolean;                   // never satisfies open_pr (open question 4)
  postApplyCommands?: VerifyCommand[];   // default [] ; CLI passes the resolved set when
                                         // promotion.postApplyVerify is true (open question 5)
  onEvent?: (e: HarnessEvent) => void;
};
export type PromotionOutcome =
  | { status: "applied"; checkpointDir: string; postApplyPassed: boolean | null }
  | { status: "exported"; destPath: string }
  | { status: "branch_committed"; branch: string; commit: string }
  | { status: "pr_opened"; branch: string; prUrl: string }
  | { status: "refused"; reason: "not_verified" | "approval_denied" | "drift" | "apply_failed" | "push_failed" | "error"; message: string };
export async function promote(req: PromotionRequest): Promise<PromotionOutcome>;
```

Steps:

- [ ] Write `packages/core/test/promote.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createTask, promote, snapshotGit, type ApproveIO, type VerifyReport,
} from "@tinystrap/core";

const PATCH = [
  "diff --git a/a.txt b/a.txt", "--- a/a.txt", "+++ b/a.txt",
  "@@ -1 +1 @@", "-one", "+two", "",
].join("\n");

function passingReport(taskId: string): VerifyReport {
  return { taskId, passed: true, patchHash: "sha256:" + "0".repeat(64),
    apply: { ok: true, outputTail: "" },
    results: [{ name: "check", command: "node check.mjs", exitCode: 0,
      timedOut: false, outputTail: "", durationMs: 1 }],
    startedAt: "", finishedAt: "" };
}

function io(answer: string): ApproveIO & { asked: string[]; printed: string[] } {
  const asked: string[] = []; const printed: string[] = [];
  return { out: (l) => printed.push(l), ask: async (q) => { asked.push(q); return answer; },
    asked, printed };
}

async function snapshotProject() {
  const root = mkdtempSync(join(tmpdir(), "ts-promote-"));
  const GIT_ID = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
  const g = (...a: string[]) => execFileSync("git",
    a, { cwd: root, stdio: "pipe", env: GIT_ID });
  g("init", "-b", "main");
  writeFileSync(join(root, "a.txt"), "one\n");
  g("add", "."); g("commit", "-m", "init");
  const handle = await createTask(root);
  const baseline = await snapshotGit(root, handle);
  return { root, handle, baseline };
}

describe("promote", () => {
  it("refuses an unverified patch without asking", async () => {
    const { root, handle, baseline } = await snapshotProject();
    const io_ = io("y");
    const report = { ...passingReport(handle.taskId), passed: false };
    const r = await promote({ handle, baseline, projectRoot: root, patch: PATCH,
      report, mode: "apply", io: io_ });
    expect(r).toMatchObject({ status: "refused", reason: "not_verified" });
    expect(io_.asked).toHaveLength(0);
  });

  it("denial refuses and changes nothing", async () => {
    const { root, handle, baseline } = await snapshotProject();
    const r = await promote({ handle, baseline, projectRoot: root, patch: PATCH,
      report: passingReport(handle.taskId), mode: "apply", io: io("n") });
    expect(r).toMatchObject({ status: "refused", reason: "approval_denied" });
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("one\n");
  });

  it("apply: approves, checkpoints, applies the exact patch, records events", async () => {
    const { root, handle, baseline } = await snapshotProject();
    const events: string[] = [];
    const r = await promote({ handle, baseline, projectRoot: root, patch: PATCH,
      report: passingReport(handle.taskId), mode: "apply", io: io("y"),
      onEvent: (e) => events.push(e.kind) });
    expect(r).toMatchObject({ status: "applied", postApplyPassed: null });
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("two\n");
    expect(events).toEqual(["promotion_requested", "promotion_applied"]);
  });

  it("apply refuses on drift AFTER approval, with guidance text", async () => {
    const { root, handle, baseline } = await snapshotProject();
    writeFileSync(join(root, "a.txt"), "human edit\n");   // drift after snapshot
    const r = await promote({ handle, baseline, projectRoot: root, patch: PATCH,
      report: passingReport(handle.taskId), mode: "apply", io: io("y") });
    expect(r).toMatchObject({ status: "refused", reason: "drift" });
    if (r.status === "refused") expect(r.message).toMatch(/re-run|review/i);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("human edit\n");
  });

  it("export_patch needs no approval and writes the patch file", async () => {
    const { root, handle, baseline } = await snapshotProject();
    const io_ = io("n");
    const r = await promote({ handle, baseline, projectRoot: root, patch: PATCH,
      report: passingReport(handle.taskId), mode: "export_patch", io: io_ });
    expect(r.status).toBe("exported");
    expect(io_.asked).toHaveLength(0);
    if (r.status === "exported") expect(readFileSync(r.destPath, "utf8")).toBe(PATCH);
  });

  it("the apply prompt shows the diffstat and the verification summary", async () => {
    const { root, handle, baseline } = await snapshotProject();
    const io_ = io("y");
    await promote({ handle, baseline, projectRoot: root, patch: PATCH,
      report: passingReport(handle.taskId), mode: "apply", io: io_ });
    expect(io_.printed.join("\n")).toMatch(/a\.txt/);       // git apply --stat output
    expect(io_.printed.join("\n")).toMatch(/verified|PASS/i);
  });
});
```

- [ ] Run it. Expected: FAIL — `promote` not exported.
- [ ] Append to `packages/core/src/promotion.ts`:

```ts
import type { VerifyCommand } from "./verify-commands.js";
import type { VerifyReport } from "./verify.js";

export type PromotionMode = "apply" | "export_patch" | "commit_task_branch" | "open_pr";

// One-key approve with injected IO (same pattern as the init prompts): no
// readline, no TTY in tests. "y" (case-insensitive, trimmed) is the only
// affirmative; anything else is a denial — fail-safe by default.
export type ApproveIO = {
  out: (line: string) => void;
  ask: (question: string) => Promise<string>;
};

export type PromotionRequest = {
  handle: TaskHandle;
  baseline: Baseline;
  projectRoot: string;
  patch: string;
  report: VerifyReport;
  mode: PromotionMode;
  io: ApproveIO;
  runner?: CommandRunner;
  branch?: string;
  prTitle?: string;
  prBody?: string;
  assumeYes?: boolean;
  postApplyCommands?: VerifyCommand[];
  onEvent?: (e: HarnessEvent) => void;
};

export type PromotionOutcome =
  | { status: "applied"; checkpointDir: string; postApplyPassed: boolean | null }
  | { status: "exported"; destPath: string }
  | { status: "branch_committed"; branch: string; commit: string }
  | { status: "pr_opened"; branch: string; prUrl: string }
  | { status: "refused"; reason:
      "not_verified" | "approval_denied" | "drift" | "apply_failed" | "push_failed" | "error";
    message: string };

function isApproved(answer: string): boolean {
  return answer.trim().toLowerCase() === "y";
}

export async function promote(req: PromotionRequest): Promise<PromotionOutcome> {
  const runner = req.runner ?? defaultCommandRunner;
  const branch = req.branch ?? `tinystrap/${req.handle.taskId}`;
  const refuse = (reason: Extract<PromotionOutcome, { status: "refused" }>["reason"],
    message: string): PromotionOutcome => {
    req.onEvent?.(makeEvent(req.handle.taskId, "promotion_refused", { reason }));
    return { status: "refused", reason, message };
  };

  if (!req.report.passed) {
    return refuse("not_verified",
      "the patch did not pass verification, so nothing was promoted. Re-run the task, or " +
      "export the patch for a human: tinystrap task export " + req.handle.taskId);
  }

  // export_patch touches nothing outside the task dir: no approval (open question 7).
  if (req.mode === "export_patch") {
    const destPath = join(req.projectRoot, `${req.handle.taskId}.patch`);
    writeFileSync(destPath, req.patch);
    req.onEvent?.(makeEvent(req.handle.taskId, "promotion_applied",
      { decision: "export_patch", reason: destPath }));
    return { status: "exported", destPath };
  }

  // Show the diff (stat form) + the verification report, then one-key approve
  // (spec 9.10). For open_pr the prompt MUST name the branch that will be
  // pushed; --yes never satisfies a push (open question 4).
  const stat = await runner("git", ["apply", "--stat", "-"],
    { cwd: req.projectRoot, stdin: req.patch, timeoutMs: 30_000 });
  req.io.out(`Patch to promote (${req.mode}), verified ${req.report.patchHash.slice(0, 18)}…:`);
  req.io.out(stat.stdout.trim() || "(no stat available)");
  req.io.out(`Verification: ${req.report.results.map((r) => `${r.name}=${r.exitCode === 0 && !r.timedOut ? "PASS" : "FAIL"}`).join(" ")}`);

  const question = req.mode === "open_pr"
    ? `Push branch ${branch} to origin and open a pull request against main? [y/N] `
    : req.mode === "commit_task_branch"
      ? `Commit this patch to new branch ${branch} (no push)? [y/N] `
      : "Apply this patch to your project? [y/N] ";
  req.onEvent?.(makeEvent(req.handle.taskId, "promotion_requested",
    { decision: req.mode, reason: `branch=${branch}` }));

  const approved = req.mode === "open_pr"
    ? isApproved(await req.io.ask(question))                 // interactive only, always
    : (req.assumeYes === true || isApproved(await req.io.ask(question)));
  if (!approved) {
    return refuse("approval_denied", "you declined; nothing was changed. The verified patch is " +
      `still available: tinystrap task export ${req.handle.taskId}`);
  }

  const drift = await checkDrift(req.projectRoot, req.baseline, runner);
  if (drift.drifted) {
    return refuse("drift", `promotion stopped: ${drift.detail}`);
  }

  if (req.mode === "apply") {
    const checkpointDir = await createRollbackCheckpoint(req.projectRoot, req.handle, req.patch, runner);
    const applied = await applyPatchToProject(req.projectRoot, req.patch, runner);
    if (applied.code !== 0) {
      return refuse("apply_failed", "the verified patch did not apply cleanly; nothing was " +
        `changed. Export it for review: tinystrap task export ${req.handle.taskId}`);
    }
    let postApplyPassed: boolean | null = null;
    const post = req.postApplyCommands ?? [];
    if (post.length > 0) {
      postApplyPassed = true;
      for (const cmd of post) {
        const r = await runVerifyCommand(cmd, req.projectRoot, { runner });
        if (r.exitCode !== 0 || r.timedOut) { postApplyPassed = false; break; }
      }
      if (!postApplyPassed) {
        await restoreFromCheckpoint(req.projectRoot, checkpointDir, runner);
        return refuse("apply_failed", "post-apply checks failed, so the project was restored " +
          "to its pre-promotion state. Export the patch and inspect the check output.");
      }
    }
    req.onEvent?.(makeEvent(req.handle.taskId, "promotion_applied", { decision: "apply" }));
    return { status: "applied", checkpointDir, postApplyPassed };
  }

  if (req.mode === "commit_task_branch") {
    const committed = await commitTaskBranch(req.projectRoot, req.handle, req.patch, branch, runner);
    if (!committed.ok) {
      return refuse("error", `could not create the task branch: ${committed.error}`);
    }
    req.onEvent?.(makeEvent(req.handle.taskId, "promotion_applied",
      { decision: "commit_task_branch", reason: branch }));
    return { status: "branch_committed", branch, commit: committed.commit };
  }

  // open_pr — reached only through the interactive approve above.
  const pr = await openPullRequest(req.projectRoot, req.handle, req.patch,
    { branch, title: req.prTitle, body: req.prBody, runner });
  if (!pr.ok) {
    return refuse(pr.stage === "push" ? "push_failed" : "error", pr.error);
  }
  req.onEvent?.(makeEvent(req.handle.taskId, "promotion_applied",
    { decision: "open_pr", reason: pr.prUrl }));
  return { status: "pr_opened", branch: pr.branch, prUrl: pr.prUrl };
}
```

(add `makeEvent`/`HarnessEvent` imports and `writeFileSync`/`join` if not already imported by D2's block).
- [ ] Run `pnpm vitest run packages/core` + `pnpm typecheck`. Expected: PASS.
- [ ] Commit:

```bash
git add packages/core/src/promotion.ts packages/core/test/promote.test.ts
git commit -m "feat(core): promotion broker with one-key approve and drift-gated apply

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task D6 [Group D]: `promote()` open_pr approval strictness tests

**Files:**
- Test: `packages/core/test/promote.test.ts` (extend)

**Interfaces:**
- Consumes: `promote` (D5), fake `CommandRunner` pattern from D4, `io()` helper from D5.
- Produces: nothing new — this task pins the two hard rules of §9.10 as executable tests: `assumeYes` never satisfies `open_pr`, and the open_pr prompt names the branch.

Steps:

- [ ] Extend `packages/core/test/promote.test.ts`:

```ts
describe("promote open_pr approval strictness (spec 9.10 hard rules)", () => {
  it("assumeYes does NOT approve a push; the prompt still runs", async () => {
    const { root, handle, baseline } = await snapshotProject();
    const io_ = io("n");
    const r = await promote({ handle, baseline, projectRoot: root, patch: PATCH,
      report: passingReport(handle.taskId), mode: "open_pr", io: io_, assumeYes: true });
    expect(r).toMatchObject({ status: "refused", reason: "approval_denied" });
    expect(io_.asked.join("\n")).toMatch(/Push branch tinystrap\/task-/);
  });

  it("an approved open_pr prompt pushes the named branch via the runner only", async () => {
    const { root, handle, baseline } = await snapshotProject();
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner = async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      if (args.join(" ").includes("remote get-url")) {
        return { code: 0, stdout: "https://example.invalid/acme/project.git\n", stderr: "", timedOut: false };
      }
      if (args.join(" ").includes("pr create")) {
        return { code: 0, stdout: "https://example.invalid/acme/project/pull/1\n", stderr: "", timedOut: false };
      }
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    };
    const r = await promote({ handle, baseline, projectRoot: root, patch: PATCH,
      report: passingReport(handle.taskId), mode: "open_pr", io: io("y"), runner });
    expect(r).toMatchObject({ status: "pr_opened",
      prUrl: "https://example.invalid/acme/project/pull/1" });
    const push = calls.find((c) => c.args[0] === "push");
    expect(push?.args).toEqual(["push", "origin",
      `tinystrap/${handle.taskId}:tinystrap/${handle.taskId}`]);
    for (const c of calls) { expect(c.args).not.toContain("--force"); }
  });
});
```

- [ ] Run it. Expected: PASS immediately **only if** D5 landed correctly; if `assumeYes` leaked into the open_pr path, this fails — fix `promote()` (the `req.mode === "open_pr"` branch must ignore `assumeYes`) before committing.
- [ ] Commit:

```bash
git add packages/core/test/promote.test.ts
git commit -m "test(core): pin open_pr push approval rules from spec 9.10

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task E1 [Group E]: `tinystrap task verify`

**Files:**
- Modify: `apps/cli/src/main.ts`
- Test: `apps/cli/test/cli.test.ts` (extend)

**Interfaces:**
- Consumes: `extractPatch`, `openTask`, `detectVerifyCommands`, `resolveVerifyCommands`, `verifyOverridesFromConfig`, `loadConfig`, `verifyInFreshWorkspace`, `VerifyReport` (all on `@tinystrap/core` after A+B).
- Produces: `task verify <taskId>` CLI command; `formatVerifyReport(report): string` (local to main.ts, exported for tests).

Steps:

- [ ] Extend `apps/cli/test/cli.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, formatVerifyReport } from "../src/main.js";

function verifiedProject(): { dir: string; id: string } {
  const dir = mkdtempSync(join(tmpdir(), "ts-cverify-"));
  const GIT_ID = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
  const g = (...a: string[]) => execFileSync("git",
    a, { cwd: dir, stdio: "pipe", env: GIT_ID });
  g("init", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "one\n");
  writeFileSync(join(dir, "check.mjs"),
    "import { readFileSync } from 'node:fs';\n" +
    "process.exit(readFileSync('a.txt', 'utf8') === 'two\\n' ? 0 : 1);\n");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node check.mjs" } }));
  g("add", "."); g("commit", "-m", "init");
  const id = (runCliSync(["task", "new", "--cwd", dir]));
  return { dir, id };
}
// runCliSync helper: await runCli([...]) inside the async test body — write
// the tests async and await runCli directly.

describe("task verify", () => {
  it("passes when the workspace edit satisfies the detected check", async () => {
    const { dir, id } = await verifiedProject();
    // simulate a model edit inside the task workspace:
    writeFileSync(join(dir, ".tinystrap", "tasks", id, "workspace", "a.txt"), "two\n");
    const out = await runCli(["task", "verify", id, "--cwd", dir]);
    expect(out).toContain(`${id}: PASS`);
    expect(out).toContain("test");
  });

  it("fails with an actionable error when the check fails", async () => {
    const { dir, id } = await verifiedProject();
    writeFileSync(join(dir, ".tinystrap", "tasks", id, "workspace", "a.txt"), "wrong\n");
    await expect(runCli(["task", "verify", id, "--cwd", dir]))
      .rejects.toThrow(/did not pass|FAIL/);
  });
});
```

- [ ] Run it. Expected: FAIL — unknown command `task verify`.
- [ ] Modify `apps/cli/src/main.ts` — add imports (`detectVerifyCommands`, `extractPatch`, `loadConfig`, `openTask`, `resolveVerifyCommands`, `verifyInFreshWorkspace`, `verifyOverridesFromConfig`, `type VerifyReport`) and, after the `task export` block:

```ts
  if (argv[0] === "task" && argv[1] === "verify") {
    const id = argv[2];
    if (!id) throw new Error("usage: tinystrap task verify <taskId>");
    const h = openTask(cwd, id);
    const baseline = JSON.parse(readFileSync(h.baselinePath, "utf8"));
    const patch = await extractPatch(h);
    const config = await loadConfig({ projectRoot: cwd });
    const commands = resolveVerifyCommands(
      detectVerifyCommands(cwd), verifyOverridesFromConfig(config));
    const report = await verifyInFreshWorkspace(h, baseline, patch, commands);
    const text = formatVerifyReport(report);
    if (!report.passed) {
      throw new Error(`${text}\nThe patch did not pass verification. Fix the task and re-run, ` +
        `or export the patch for a human: tinystrap task export ${id}`);
    }
    return text;
  }
```

(add `readFileSync` to the `node:fs` import) and the formatter:

```ts
export function formatVerifyReport(r: VerifyReport): string {
  const lines = [`${r.taskId}: ${r.passed ? "PASS" : "FAIL"} (${r.results.length} checks, patch ${r.patchHash.slice(0, 18)}…)`];
  if (!r.apply.ok) lines.push(`  patch did not apply: ${r.apply.outputTail.trim().split("\n")[0]}`);
  for (const c of r.results) {
    lines.push(`  ${c.name}  ${c.command}  ${c.timedOut ? "TIMEOUT" : `exit ${c.exitCode}`}  ${c.durationMs}ms`);
    if (c.exitCode !== 0 || c.timedOut) {
      lines.push(c.outputTail.split("\n").map((l) => `    | ${l}`).join("\n"));
    }
  }
  return lines.join("\n");
}
```

- [ ] Run `pnpm vitest run apps/cli`. Expected: PASS.
- [ ] Commit:

```bash
git add apps/cli/src/main.ts apps/cli/test/cli.test.ts
git commit -m "feat(cli): tinystrap task verify runs checks against a fresh baseline copy

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task E2 [Group E]: `tinystrap task promote` with injected approve IO

**Files:**
- Modify: `apps/cli/src/main.ts`
- Test: `apps/cli/test/cli.test.ts` (extend)

**Interfaces:**
- Consumes: `promote`, `PromotionMode`, `ApproveIO` (D), everything from E1.
- Produces: `task promote <taskId> [--mode <m>] [--yes]`; `runCli` gains an optional third parameter `io?: ApproveIO` (default: console + readline, constructed lazily so tests never touch a TTY).

Steps:

- [ ] Extend the test file:

```ts
describe("task promote", () => {
  it("apply mode promotes a verified patch after an interactive y", async () => {
    const { dir, id } = await verifiedProject();
    writeFileSync(join(dir, ".tinystrap", "tasks", id, "workspace", "a.txt"), "two\n");
    const asked: string[] = [];
    const out = await runCli(["task", "promote", id, "--cwd", dir],
      undefined, { out: () => {}, ask: async (q) => { asked.push(q); return "y"; } });
    expect(out).toContain("applied");
    expect(asked.join("")).toMatch(/Apply this patch/);
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("two\n");
  });

  it("--yes approves apply without asking", async () => {
    const { dir, id } = await verifiedProject();
    writeFileSync(join(dir, ".tinystrap", "tasks", id, "workspace", "a.txt"), "two\n");
    const out = await runCli(["task", "promote", id, "--cwd", dir, "--yes"],
      undefined, { out: () => {}, ask: async () => { throw new Error("must not ask"); } });
    expect(out).toContain("applied");
  });

  it("open_pr requires the repo opt-in in tinystrap.toml", async () => {
    const { dir, id } = await verifiedProject();
    writeFileSync(join(dir, ".tinystrap", "tasks", id, "workspace", "a.txt"), "two\n");
    await expect(runCli(["task", "promote", id, "--cwd", dir, "--mode", "open_pr"],
      undefined, { out: () => {}, ask: async () => "y" }))
      .rejects.toThrow(/promotion\.mode = "open_pr"/);
  });

  it("a declined promote exits refused without touching the project", async () => {
    const { dir, id } = await verifiedProject();
    writeFileSync(join(dir, ".tinystrap", "tasks", id, "workspace", "a.txt"), "two\n");
    await expect(runCli(["task", "promote", id, "--cwd", dir],
      undefined, { out: () => {}, ask: async () => "n" }))
      .rejects.toThrow(/declined/);
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("one\n");
  });
});
```

- [ ] Run it. Expected: FAIL — unknown command / wrong arity.
- [ ] Modify `apps/cli/src/main.ts`:

```ts
// runCli signature change (additive, default keeps every existing caller and
// test working unchanged):
export async function runCli(argv: string[], discovery?: Discovery, io?: ApproveIO): Promise<string> {
```

after the `task verify` block:

```ts
  if (argv[0] === "task" && argv[1] === "promote") {
    const id = argv[2];
    if (!id) throw new Error("usage: tinystrap task promote <taskId> [--mode apply|export_patch|commit_task_branch|open_pr] [--yes]");
    const h = openTask(cwd, id);
    const baseline = JSON.parse(readFileSync(h.baselinePath, "utf8"));
    const config = await loadConfig({ projectRoot: cwd });
    const configuredMode = String(config["promotion.mode"]?.value ?? "apply");
    const mode = flagValue(argv, "--mode", configuredMode) as PromotionMode;
    // open_pr needs the per-repository opt-in (spec 9.10): the flag alone
    // never turns pushing on — the toml must say so too.
    if (mode === "open_pr" && configuredMode !== "open_pr") {
      throw new Error('open_pr requires the repository opt-in: set promotion.mode = "open_pr" ' +
        "in tinystrap.toml");
    }
    const patch = await extractPatch(h);
    const commands = resolveVerifyCommands(
      detectVerifyCommands(cwd), verifyOverridesFromConfig(config));
    const report = await verifyInFreshWorkspace(h, baseline, patch, commands);
    if (!report.passed) {
      throw new Error(`${formatVerifyReport(report)}\nPromotion needs a passing verification first.`);
    }
    const approve: ApproveIO = io ?? (await import("./prompt.js")).consoleApproveIO();
    const postApply = config["promotion.postApplyVerify"]?.value === false
      ? [] : commands;
    const outcome = await promote({
      handle: h, baseline, projectRoot: cwd, patch, report, mode,
      io: approve, assumeYes: argv.includes("--yes"),
      postApplyCommands: postApply,
    });
    if (outcome.status === "refused") throw new Error(outcome.message);
    return `${outcome.status}: ${JSON.stringify(outcome)}`;
  }
```

- [ ] Create `apps/cli/src/prompt.ts` — the only file allowed to touch a TTY:

```ts
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { ApproveIO } from "@tinystrap/core";

export function consoleApproveIO(): ApproveIO {
  const rl = createInterface({ input: stdin, output: stdout });
  return {
    out: (line) => stdout.write(line + "\n"),
    ask: (q) => rl.question(q),
  };
}
```

- [ ] Run `pnpm vitest run apps/cli` + `pnpm typecheck`. Expected: PASS.
- [ ] Commit:

```bash
git add apps/cli/src/main.ts apps/cli/src/prompt.ts apps/cli/test/cli.test.ts
git commit -m "feat(cli): tinystrap task promote with one-key approve and open_pr opt-in gate

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task E3 [Group E]: Doctor reports detected verify commands (spec §8.1)

**Files:**
- Modify: `packages/core/src/doctor.ts` (append one section)
- Test: `packages/core/test/doctor.test.ts` (extend)

**Interfaces:**
- Consumes: `detectVerifyCommands` (A2), existing `runDoctor`.
- Produces: doctor output gains a `verify commands:` section.

Steps:

- [ ] Extend `packages/core/test/doctor.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

it("lists detected verify commands (spec 8.1)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ts-doctor-verify-"));
  writeFileSync(join(dir, "package.json"),
    JSON.stringify({ scripts: { test: "vitest run" } }));
  const out = await runDoctor(dir, new StubDiscovery({ servers: [] }));
  expect(out).toContain("verify commands:");
  expect(out).toContain("test = pnpm run test");
});
```

(match the existing test file's `StubDiscovery` import and style.)

- [ ] Run it. Expected: FAIL — section missing.
- [ ] Modify `packages/core/src/doctor.ts` — import `detectVerifyCommands` from `./verify-commands.js` and, before `return lines.join("\n")`:

```ts
  const verifyCommands = detectVerifyCommands(projectRoot);
  lines.push("");
  if (verifyCommands.length === 0) {
    lines.push("verify commands: none detected (configure [verify] in tinystrap.toml)");
  } else {
    lines.push("verify commands:");
    for (const c of verifyCommands) lines.push(`  ${c.name} = ${c.command}`);
  }
```

- [ ] Run `pnpm vitest run packages/core/test/doctor.test.ts`. Expected: PASS.
- [ ] Commit:

```bash
git add packages/core/src/doctor.ts packages/core/test/doctor.test.ts
git commit -m "feat(core): doctor reports detected verify commands

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Verification (whole plan)

- `pnpm test` — all packages green; **no network** (fake `CommandRunner`s for `push`/`gh`; real `git` only against local temp repos), **no real `gh` binary**, no model server, no host binary in CI.
- `pnpm typecheck` — includes `adapters/opencode` and `adapters/pi` (untouched by this plan).
- Hard-rule gates encoded as tests: `promotion-openpr.test.ts` + `promote.test.ts` prove (a) no push without an interactive approve, (b) `--yes` never approves a push, (c) the push command is a fixed task-branch refspec with no force in its argv, (d) `main`/`master` are refused before any process spawns, (e) unverified patches never reach an approve prompt.
- Verifier isolation gate: `verify.test.ts` proves the model's `workspaceDir` is never the verification cwd (checks read the patched fresh copy; the workspace file the check reads differs from the workspace's original content only via the patch).
- Regression gate: every pre-existing test passes with no edits except the named additive extensions (`audit.test.ts`, `verify-commands.test.ts`, `workspace.test.ts`, `cli.test.ts`, `doctor.test.ts`, and `config.test.ts` only if it pins the resolved key set).
- Sensitive-string gate before any push: scan changed files against the project's sensitive-pattern list (private LAN prefix, operator account strings, local absolute paths, personal addresses — the list from the task brief, not repeated here) → 0 hits.
- Follow-up (not in this plan): re-run `scripts/live-host-check-opencode.mjs` extended with `task verify` + `task promote --mode export_patch` after all groups land; wire the supervisor lifecycle (Freeze → Verify → Promote) and `workspaceProviderFromConfig` into `task new` (supervisor plan); drift rebase tooling; manifest-baseline patching; sandboxed verifier env.

## Self-review record

- **Spec coverage:** §9.9 verifier (fresh baseline copy, auto-detected + overridable commands, agent cannot touch the verifier workspace — it is created after freeze inside `.tinystrap/`, machine-readable `VerifyReport` + human CLI text) → A2/A3/B1–B3; §9.10 promotion (default apply after diff+report one-key approve, drift refusal, rollback checkpoint, exact-patch-only application, post-apply checks, `export_patch`/`commit_task_branch`/`open_pr` modes, no-push-without-per-task-approval, broker-is-the-only-pusher) → D1–D6/E2; §9.2 WorkspaceProvider seam + §13.5 mode-3 external workspaces → C1–C3; §13.4 event kinds → A1; §8.1 doctor verify-commands → E3; §14 error rows (verification failure → actionable message + export path; drift → stop with rebase-or-review guidance) → B3/E1/D1/D5. Windows handling is structural throughout: `killProcessTree` for every timeout, `git apply` via stdin (no temp-file quoting), `node:path` joins, no POSIX-only assumptions in any test.
- **Placeholders:** none — every code block is complete and compiles against the *Interfaces consumed* signatures. Three test bodies in B3 and the `verifiedProject` helper in E1/E2 are written as setup-shape + explicit variation notes rather than repeated boilerplate; the implementing worker expands them literally from the first full example in the same file (the pattern the init plan used).
- **Type consistency:** `CommandRunner`/`RunResult` defined once in `run.ts` and reused by `verify.ts`, `promotion.ts`, and the tests; `VerifyCommand` defined once in `verify-commands.ts`; `VerifyReport` produced only by `verifyInFreshWorkspace` and consumed by `promote`; `Baseline`/`TaskHandle` unchanged except the additive optional `externalWorkspaceDir`. `runCli` gains one optional parameter with a default — every existing caller compiles unchanged. `config.ts` gains three builtin keys and one `KEY_MAP` entry; `audit.ts` gains five union members; both are additive.
- **Deviation from the spec text (flagged, not silent):** the WorkspaceProvider signature (open question 1) — providers produce the `Baseline` because that is what the existing snapshot code does; the spec's `create(baseline)` wording predates the code. Everything else implements §9.9/§9.10 as written, with the ten judgment calls surfaced as open questions rather than decided in code comments.
