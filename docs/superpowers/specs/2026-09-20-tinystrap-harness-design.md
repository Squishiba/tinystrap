# tinystrap Local Coding Harness — Design Specification

**Status:** Approved design spec (extends `DESIGN.md`)

**Date:** 2026-09-20

**Base document:** `DESIGN.md` (this repository). This spec keeps DESIGN.md's
structure and content wherever that document is not contradicted by a decision
recorded here. Every decision below is approved by the user. Sections of
DESIGN.md that are superseded are called out explicitly in **Supersedes**
notes. Unverified claims about external tools are marked **to verify**.

---

## 1. Summary

tinystrap is a local coding harness for small and medium-sized AI models, with
one goal stated above all others: **be the best coding harness for small
models.** It runs a local model against a disposable task workspace, enforces
safety policy before any side effect happens, helps the model where small
models are weak (tool-call quality, context management, edit precision,
reasoning loops), verifies the result in a clean environment, and promotes only
an exact, human-approved patch back to the protected project.

The central safety and workflow rule from DESIGN.md stands unchanged:

> The model never edits the user's protected project directly. It edits a
> disposable task workspace. The harness verifies the resulting change set and
> separately decides whether to promote it back to the protected project.

Scope of this spec: **the whole of DESIGN.md as one specification**, with
milestones M1–M6 kept as ordered sections (§16) so the system can still be
planned and built incrementally.

The two cooperating layers from DESIGN.md stand, with one addition:

1. A **task supervisor** that creates isolated workspaces, launches the agent,
   runs verification, and controls promotion.
2. A **model/runtime adapter** (OpenCode or pi) that is deliberately thin.
3. A **provider-stream proxy** (new, §10) that sits between the host agent and
   the local model server and is the single enforcement point for the M5
   streaming preflight gate.

The policy engine is backend-neutral; OpenCode and pi adapters are thin
wrappers around it rather than the source of truth for safety policy.

## 2. Goals

### Primary goals

- Run local coding models against a disposable project workspace.
- Give the model broad practical freedom inside that workspace.
- Prevent the model from writing to the protected project during normal
  execution.
- Detect unavailable or forbidden tools as early as possible during tool-call
  generation.
- Interrupt forbidden tool calls before the tool implementation, file
  operation, or shell process starts.
- Explain every interruption to the model in a concise, actionable form.
- Verify proposed changes in a fresh environment before promotion.
- Promote only the exact verified change set, never an entire scratch
  directory.
- Detect source drift before applying a task's changes to the protected
  project.
- Preserve enough logs and metadata to understand why a call was allowed,
  denied, rewritten, or interrupted.
- **Compensate for small-model weaknesses** with a dedicated small-model layer
  (§12): tool-call repair, context budgeting, edit assistance, guidance, and
  reasoning control — each mechanism individually switchable and judged by
  benchmark ablation.
- **Require zero user input to discover the local model server**: models,
  context lengths, and capabilities are probed automatically (§8).
- Keep configuration in exactly one project file plus an optional user-level
  defaults file (§7).

### Secondary goals

- Support OpenCode first, with a pi adapter close behind.
- Support Git repositories and non-Git projects.
- Support different capability profiles for planning, implementation,
  verification, and promotion.
- Make the system useful with models that have imperfect tool-call behavior.
- Keep the policy engine deterministic and inexpensive; routine authorization
  does not require another LLM (the optional LLM judge is tighten-only and off
  in v1, §9.7).

## 3. Non-goals

Carried over from DESIGN.md unchanged:

- Building a general-purpose host security product.
- Treating a prompt or system instruction as a sufficient security boundary.
- Letting the model decide whether its own work is safe to promote.
- Automatically pushing to a remote repository. **No push without explicit
  per-task user approval** is a hard rule, not merely a default — the model
  never pushes (§9.10).
- Automatically accepting every change merely because tests pass.
- Requiring a single model provider or local inference server.

Added:

- Supporting more than one project config file, per-directory config cascade,
  or settings stored anywhere other than `tinystrap.toml`, the user-level
  defaults file, and the disposable `.tinystrap/` data dir (§7).
- Building a general-purpose reasoning framework; the reasoning-control
  mechanisms exist only to make small models code better under this harness.

## 4. Design principles

All DESIGN.md principles stand:

- **4.1 Disposable by default** — every task runs in an ephemeral workspace;
  the default recovery is discard-and-restart from baseline.
- **4.2 Policy before execution** — a denied request must not reach the tool
  implementation, open a file, start a process, make a request, or spawn a
  subagent.
- **4.3 Early rejection, final validation** — reject as soon as invalidity is
  provable; still fully validate after all arguments are available.
- **4.4 The model proposes; the harness decides.**
- **4.5 Human work is never overwritten silently** — drift pauses promotion.

Added principles:

- **4.6 One enforcement point for the stream.** All streaming-gate decisions
  happen in the provider-stream proxy (§10). Adapters only point their base
  URL at the proxy and add pre-execution blocking hooks. This avoids two
  divergent implementations of the same gate.
- **4.7 Structural enforcement is the wall; heuristics are the friendly
  layer.** The sandbox, OS permissions, the disposable workspace, the
  verifier, and the promotion broker are what make the system safe. Shell and
  Python analyzers and the evasion detector are a fast, forgiving convenience
  layer; their false positives are tracked as a real cost (§9.7).
- **4.8 Zero-input by default.** The user installs tinystrap, runs it in a
  project, and it discovers the server, models, and context lengths without
  being asked (§8). Every discovered value is overridable in one file (§7).
- **4.9 Every small-model aid is switchable and measured.** No mechanism in
  §12 ships as an unmeasurable always-on behavior; each has an ablation switch
  and is kept only if benchmarks say it helps.

## 5. High-level architecture

```text
                         User
                           │
                           ▼
                   Task Supervisor
             ┌─────────────┼──────────────┐
             │             │              │
             ▼             ▼              ▼
       Snapshot       Runtime         Promotion
       Manager        Adapter         Broker
             │        (OpenCode/pi)       │
             │             │              │
             ▼             ▼              ▲
      Task Workspace   Agent loop         │
             │             │              │
             │             ▼              │
             │      Provider-stream       │
             │         proxy  ◄── streaming gate, tool-call repair,
             │             │              context budgeting, profiles,
             │             ▼              reasoning control
             │      Local model server
             │      (llama.cpp / Ollama / LM Studio)
             │
             └─────────────┴── Policy Engine
                    ├── Capability Compiler
                    ├── Preflight Gate (in proxy + adapter hooks)
                    └── Effect classifier / Evasion detector
```

The protected-project → task-workspace → patch → verifier → promotion pipeline
from DESIGN.md §5 is unchanged. The task workspace is produced by a pluggable
**WorkspaceProvider** (§9.2): an independent temporary clone by default, or a
host-supplied directory (e.g. an AO (Agent Orchestrator) or git worktree) in
external mode.

## 6. Stack and package layout

**Decision:** the core is **TypeScript**. TypeScript is shared with the
OpenCode plugin ecosystem and pi's plugin types, so adapter code and the
policy core share types directly. The benchmark runner may call **Python
drivers** for public benchmarks (Aider Polyglot and Terminal-Bench have
Python tooling); those drivers live behind the `bench` package boundary and are
invoked as subprocesses, never linked into the core.

Monorepo packages:

| Package            | Contents                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------- |
| `core`             | task lifecycle, snapshot manager, patch extraction, verifier orchestration, promotion broker |
| `policy`           | tool registry, capability compiler, effect classifier, shell analyzer, Python analyzer, evasion detector, audit log — **no I/O dependencies**; pure functions over data |
| `proxy`            | provider-stream proxy: streaming gate, tool-call repair, context budgeting, model profiles, reasoning control |
| `discovery`        | zero-input server probing: models, context lengths, per-server probes (§8)                    |
| `adapters/opencode`| thin OpenCode plugin: base URL, `execute.before` blocking hook, capability filtering, logging |
| `adapters/pi`      | thin pi plugin: base URL, `tool_call` event returning `{block: true}`, logging                 |
| `sandbox`          | pluggable sandbox interface + backends (§9.8)                                                 |
| `bench`            | benchmark harness: own task suite, Aider Polyglot driver, Terminal-Bench driver, ablation switches, metrics (§15) |

Dependency direction: `adapters/*`, `proxy`, `bench` → `policy` + `core` types;
`policy` depends on nothing but the shared types package. `policy` performs no
filesystem, network, or process I/O, which keeps it unit-testable and makes it
impossible for policy evaluation itself to cause a side effect.

## 7. Configuration (hard requirement)

**One config file.** `tinystrap.toml` in the project root, plus an optional
user-level defaults file (`~/.config/tinystrap/defaults.toml` on Unix,
`%APPDATA%/tinystrap/defaults.toml` on Windows). **No other place stores
settings.** Task state (baselines, workspaces, logs, patches) lives in one
disposable `.tinystrap/` data dir under the project root and is never a
configuration source — deleting it is always safe.

Precedence, lowest to highest:

```text
built-in defaults  <  user-level defaults file  <  discovered values (§8)  <  tinystrap.toml  <  CLI flags
```

Discovered values (server URL, model list, context lengths) sit below the
config file so a user override always wins over a probe result.

`tinystrap doctor` (§8.3) prints every resolved value together with **where it
came from** (built-in / user defaults / discovery / project config / CLI flag).

Illustrative shape (not exhaustive; all keys optional):

```toml
# tinystrap.toml
[server]
# base_url omitted → discovered (§8)
model = "qwen3.5-9b"          # overrides discovered default

[workspace]
provider = "independent-clone" # independent-clone | external (§9.2)
# path: required when provider = "external"

[promotion]
mode = "apply"                # apply | export_patch | commit_task_branch | open_pr

[snapshot]
allow_ignored_dirs = ["node_modules"]   # DESIGN.md open question 5, resolved §9.2

[verify]
# commands auto-detected (§9.9); override any subset:
# test = "pnpm vitest run"

[small_model]
# every §12 mechanism individually switchable; default all on
tool_call_repair = true
context_budgeting = true
edit_assistance = true
guidance = true
reasoning_control = true
pinned_notes = true
```

The `[workspace]` table selects the WorkspaceProvider (§9.2):
`independent-clone` (the default) or `external` (adopt a host-supplied
directory, e.g. an AO or git worktree, whose `path` is then required). This
stays inside the one `tinystrap.toml`; no new config files or locations are
introduced.

## 8. Zero-input server discovery (hard requirement)

The harness probes the running local server and learns **which models exist**
and **their context lengths** with no user input. The SPIKE (§10.3) ran on
2026-09-21 against a llama.cpp server (b10934, LAN `LAN-HOST:8080` —
recorded spike evidence only, never a configured default); statuses below
reflect it, evidence in `docs/superpowers/spike-findings/`.

| Server             | Probe                                                              | What it yields                          | Status |
| ------------------ | ------------------------------------------------------------------ | --------------------------------------- | ------ |
| OpenAI-compatible  | `GET /v1/models`                                                    | model ids                               | **confirmed for llama.cpp** — `data[]` entries carry `owned_by: "llamacpp"` and `meta.n_ctx` (context length is **not** absent there, contrary to this row's earlier parenthetical); other OpenAI-compatible servers: to verify |
| llama.cpp          | `GET /props`                                                        | `model_alias` (model), `default_generation_settings.n_ctx`, `build_info`, `total_slots`, `chat_template_caps` (`supports_tool_calls`, `supports_preserve_reasoning`, …) | **confirmed with corrected key paths** — the previously assumed top-level `default_model` / `n_ctx` / `context_size` keys are refuted |
| Ollama             | `GET /api/tags` + `POST /api/show` per model                        | model list, context window, parameters   | to verify (server not available during the spike) |
| LM Studio          | model-listing endpoint of its local REST server (`GET /v1/models`, model details) | model ids, loaded/installed state, context length | to verify (server not available during the spike) |

Note: llama.cpp's `/v1/models` returns **both** a `models` compatibility array
and the OpenAI-shaped `data` array; consumers must read `data`.

Server identity is itself discovered (which of llama.cpp / Ollama / LM Studio
answers on the probed port) via server-identifying routes and response shapes.
**Confirmed for llama.cpp** by response shape: `/props` returning
`build_info`/`model_alias`/`chat_template_caps`, independently by `/v1/models`
entries with `owned_by: "llamacpp"` plus a `meta` block; an unrelated listener
returning 404 on both routes was correctly excluded. Identification of Ollama
and LM Studio: **to verify**.

Discovery outputs feed the rest of the system:

- **Discovered context length drives context budgets** (§12.3): the budget
  engine sizes truncation, compaction, and file-slice limits from the actual
  `n_ctx` of the selected model, never a hardcoded guess. Caveat from the
  spike: the observed server reports `n_ctx` 128000 with `total_slots` 4, and
  whether `n_ctx` is the **total** or **per-slot** window is undetermined —
  budgets must not assume either until discovery resolves it (Appendix A10).
- **Model family selects the profile** (§12.1): the discovered model id is
  matched against bundled profile data files to pick tool set, thinking
  behavior, and repair strictness.
- If no server answers, `tinystrap doctor` explains exactly which endpoints on
  which ports were probed and what each returned (§14).

### 8.1 `tinystrap doctor`

`doctor` runs discovery, resolves the full config chain, and prints a table of
every effective value with its source. It also reports: server reachability,
detected server type and version (where exposed — to verify), selected model
and profile, detected verify commands (§9.9), sandbox backend availability,
and Git state of the project. Doctor output is the canonical answer to "why is
the harness behaving this way" and is the first artifact requested when a task
behaves oddly.

## 9. Main components

Component responsibilities from DESIGN.md §6 carry over. This section records
the deltas and the new components.

### 9.1 Task supervisor

Unchanged from DESIGN.md §6.1, with two additions: the supervisor launches the
provider-stream proxy before the agent runtime and tears it down with the
task; and the supervisor owns the `.tinystrap/` task data dir layout.

### 9.2 Snapshot manager

**Supersedes** DESIGN.md §6.2's "worktree is useful but…" discussion with a
firm decision:

- The task workspace is an **independent temporary clone**. The model **cannot
  write Git metadata** of either the protected project or the clone's origin
  linkage — `.git` internals of the protected project are never reachable from
  the agent process.
- Baseline capture: **HEAD, staged changes, unstaged changes, and untracked
  files minus secrets.** Secret detection excludes credential files, `.env`
  files, SSH keys, and token-bearing files from the untracked set.
- **Git-ignored files are excluded**, except a **configurable allowlist of
  dependency directories** (`snapshot.allow_ignored_dirs`, e.g.
  `node_modules`) so tasks can build and run without reinstalling. This
  resolves DESIGN.md open question 5.
- Non-Git projects: **hashed manifest (paths, hashes, sizes, modes, link
  metadata) plus a plain copy** of the permitted tree, same secret exclusions.
- Baseline record format: as in DESIGN.md §6.2 (`taskId`, `revision`,
  `manifestHash`, `trackedChangesHash`, `untrackedPolicy`, …).

**Workspace provider (pluggable).** Workspace creation is delegated to a
`WorkspaceProvider` so the strong standalone guarantee can be swapped for a
host-supplied workspace without touching the rest of the pipeline. The provider
is selected in `[workspace]` in `tinystrap.toml` (§7); `independent-clone` is
the default.

```ts
interface WorkspaceProvider {
  create(baseline: Baseline): Promise<TaskWorkspace>  // fresh independent clone
  adopt(path: Path): Promise<TaskWorkspace>           // host-supplied directory
}
```

| Provider | How the workspace is made | Git-metadata isolation | Used when |
| --- | --- | --- | --- |
| `independent-clone` (default) | fresh independent temporary clone from the baseline; no origin linkage to the protected project | **Structural.** The model cannot write Git metadata of the protected project or the clone's origin linkage; the project's `.git` internals are never reachable from the agent process | standalone CLI (§13.5); any host when the harness owns the workspace |
| `external` | host-supplied directory adopted as-is (e.g. an AO or git worktree) | **Not structural.** The workspace shares the host's `.git` and the worker runs with the user's full permissions | host-integrated and inside-AO modes (§13.5) |

With `external`, git-metadata isolation is **not structural**: it depends on
the policy engine denying git push, branch deletion, ref updates, and other git
write operations whose effects reach outside the workspace, plus the
credential-scrubbing rules (baseline secret exclusions above, hidden
credentials in §9.8). In **both** providers the verifier and the promotion
broker operate on the **extracted patch** — never on the workspace directory as
a whole — so the promotion guarantees hold regardless of which provider made
the workspace.

### 9.3 Task workspace

Unchanged from DESIGN.md §6.3, with the layout relocated under
`.tinystrap/tasks/<task-id>/` (project-local, disposable, git-ignored). With
the **external** provider (§9.2) the adopted host directory **is** the task
workspace: it is not disposable by the harness — task state still lives in the
`.tinystrap/` data dir, but the workspace directory itself outlives the task
and its lifecycle belongs to the host.

### 9.4 Provider-stream proxy

New; fully specified in §10. It is the single enforcement point for the M5
streaming gate and hosts the small-model layer (§12).

### 9.5 Runtime adapters (OpenCode, pi)

**Supersedes** DESIGN.md §6.4's "may require a provider-stream integration or
a small outer agent loop" hedge: the answer is **the proxy**, and the adapters
stay thin. Adapter responsibilities:

- set the provider **base URL** to the harness proxy;
- register a **pre-execution blocking hook** as a second line of defense for
  non-stream decisions (see §13 for exact hook facts);
- capability filtering before model requests (drop tools not in the current
  phase — the capability compiler computes the list);
- translate runtime events into the harness event model (§13.3);
- deliver structured interruption messages back to the model.

Adapters contain **no streaming-gate logic**. DESIGN.md §8.2's option list is
resolved: option 1 (provider-stream wrapper) is chosen.

### 9.6 Tool registry and capability compiler

Unchanged from DESIGN.md §6.5–6.6, with one extension: the registry also
carries the **effect classification** of each tool (§9.7) so the preflight
gate and the evasion detector share one vocabulary.

### 9.7 Policy engine — effects, not tools

The deterministic policy engine from DESIGN.md §6.8 stands (same
`PolicyDecision` shape: allow / ask / deny / rewrite; same
`unknown_tool` / `phase_denied` / `argument_denied` / `execution_error`
taxonomy). Four additions, all part of M2:

**(1) Policy on EFFECTS, not tools.** Every tool call is reduced by the effect
classifier to a set of effect records:

```ts
type EffectRecord = {
  target: string        // normalized path, URL, host, process, git ref…
  kind: "read" | "write" | "delete" | "exec" | "network" | "git" | "secret"
  scope: "in_workspace" | "out_of_workspace"
}
```

One rule then covers every route to the same effect: `write`, `echo >`,
`sed -i`, `tee`, `cp`, `mv`, `python open(..., "w")`, `git checkout --`, and
any future tool that produces the same record. The classifier is pure
(`policy` package, no I/O).

**(2) Static analysis.** Two analyzers feed the effect classifier:

- **Shell analyzer:** parses command strings into an AST — pipelines and
  compound commands (`&&`, `||`, `;`, `|`), subshells and `$()`, backticks,
  `eval`, variable expansion, redirections, and heredocs. Redirection and
  heredoc targets become effect records.
- **Python analyzer:** an AST scan of script content (for `python -c`,
  notebook cells, and scripts about to be executed) flagging `os.system`,
  `subprocess`, `socket`, `urllib`, `shutil`, `ctypes`, `__import__`,
  `importlib`, `exec`, `eval`, and `open()` in write mode; their targets
  become effect records where statically resolvable.
- **Fail closed:** anything unclassifiable or obfuscated (dynamic dispatch
  hiding the target, encoded payloads, parse failures) is **denied or escalated
  to ask** — never allowed by silence.

**(3) Script provenance.** When a script file is written inside the workspace,
the harness scans its content at write time and records its hash. When that
script is later executed, the harness **re-checks the hash and re-scans**
before starting the process: a script modified after a clean scan is rescanned
as new, and a script whose scan changed since approval is re-decided.

**(4) Evasion detector.** Each denied call leaves an **effect signature**
(kind + normalized target + rough shape). A later call — **via any other tool**
— whose effect records match a denied signature is flagged as an evasion
attempt. Escalation ladder: strip the offending tool from the next request →
inject an explicit correction into context → stop the task after repeats.
Flags are audit events and a benchmark metric (§15).

**(5) Optional LLM judge — later, tighten-only, off in v1.** A secondary model
may review calls the deterministic engine allowed. It can only **deny or ask,
never allow** something the engine denied. Off by default; ships disabled.

**Layering statement (principle 4.7, stated plainly):** the policy engine's
heuristics are **not a security boundary**. The real wall is structural: the
sandbox (§9.8), OS permissions, the disposable workspace, the verifier, and
the promotion broker. Heuristics exist to catch honest mistakes fast and
friendly; **false positives are tracked as a cost** (per-analyzer FP counts
are part of benchmark metrics) and every analyzer decision carries the
structural fallback that would have caught it anyway.

### 9.8 Sandbox runtime

**Supersedes** DESIGN.md §6.9's open-ended mechanism list with a concrete
first release. The first release provides:

- isolated workspace (the task dir is the only writable project root);
- **hidden credentials** — user credential stores, SSH keys, browser tokens,
  and environment secrets are not visible to the agent process;
- **scrubbed environment** — a minimal allowlisted env is passed to child
  processes;
- **resource limits** — CPU, memory, process count, output size, wall time;
- **process-tree cleanup** when the task ends or is interrupted.

The sandbox is a **pluggable backend interface** (`sandbox` package):

```ts
interface SandboxBackend {
  prepare(profile: SandboxProfile): Promise<LaunchSpec>   // env, cwd, limits, paths
  launch(spec: LaunchSpec, cmd: Command): Promise<Handle>
  cleanup(handle: Handle): Promise<void>                  // kill tree, remove temp
}
```

Later backends: **low-privilege user**, **Windows Sandbox**, **WSL2 or
container**. Backend selection is discovered (which is available on this
machine) and overridable in config; `doctor` reports the active backend.
**Policy alone is not a security boundary** — with no backend available, the
harness runs with workspace discipline only and `doctor` says so explicitly.
**Git worktrees are not a sandbox:** a worktree isolates git working state
only — the worker runs with the user's full permissions and shares one `.git`
directory with all other worktrees, so it can push, delete branches, or alter
refs unless policy stops it. The OS-level sandbox remains the only layer that
truly contains a process, and it stays deferred and pluggable.
The per-phase sandbox profiles from DESIGN.md §6.9 (implementation /
verification / promotion) stand unchanged.

### 9.9 Verifier

Unchanged from DESIGN.md §6.10 (fresh verifier workspace from the same
baseline; the eleven configured checks; agent cannot touch verifier scripts,
policy files, or the verifier baseline; machine-readable + human-readable
reports). Addition: **verify commands are auto-detected** from the project —
`package.json` scripts (`test`, `build`, `lint`, `typecheck`), `pytest`
config/files, `cargo test`, `go test`, `make`, and similar — and **any
detected command can be overridden** in `tinystrap.toml` (§7). `doctor` prints
what was detected.

### 9.10 Promotion broker

**Supersedes** DESIGN.md §6.11's default (`export_patch` during early
development) and resolves DESIGN.md open questions 6 and 7:

- **Default promotion flow:** after verification passes, the harness shows the
  user the **diff plus the verification report** and waits for a **one-key
  approve**. On approval the broker: (1) recomputes the protected project
  fingerprint and **checks drift**; (2) takes a **rollback checkpoint**;
  (3) applies **only the exact verified patch** — never a directory copy;
  (4) runs **post-apply checks**; (5) records the promotion result.
- **Drift:** blind promotion is refused; the user is offered rebase or review
  (§14).
- `export_patch` **remains a mode** (`apply` | `export_patch` |
  `commit_task_branch` | `open_pr`), as does `auto_promote` for repositories
  the user explicitly configures — but the interactive one-key default is the
  shipped behavior.
- **`open_pr` mode (new).** The promotion broker — **never the model** — pushes
  **only the task branch** (never `main`, never force) and opens a pull
  request. It does so **only after explicit per-task user approval**, and only
  if the repository opts in via `tinystrap.toml` — no other configuration
  turns it on. The push carries the already-verified task state, and which
  branch is pushed is part of the permission prompt. This composes with AO's
  (or any host's) PR/CI/review/merge flow: the PR appears in the host's normal
  tracking and CI, reviews happen there, and merging stays a human action
  (§13.5).
- **No push without explicit per-task user approval; the model never pushes.**
  This sharpens DESIGN.md's "never auto-push" (still a hard rule, not a
  default): no push happens automatically or in the background, `open_pr` is
  the only mode that pushes at all, and even it requires the per-task approve
  plus the per-repository opt-in above. The model itself cannot push — the
  broker is the only component that ever pushes a task branch to a remote.
  There is no automatic push under any other mode or configuration.

## 10. The provider-stream proxy and the M5 streaming gate

### 10.1 Why a proxy

**Decision (resolves DESIGN.md open question 2):** streaming enforcement lives
in a **provider-stream proxy** — an OpenAI-compatible HTTP endpoint that runs
between the host agent (OpenCode/pi) and the local model server. It is the
**single enforcement point** for the M5 streaming preflight gate. Rationale:

- OpenCode and pi hooks cannot see partial tool-call deltas (see facts below),
  so no adapter-side hook can implement early interruption.
- One gate implementation serves every host, present and future.
- The proxy is also the natural home for tool-call repair, context budgeting,
  profiles, and reasoning control (§12) — all of which need to see or rewrite
  the request/response stream.

Documented facts driving this design (found in the tools' docs; treated as
verified for this spec):

- **OpenCode hooks do NOT see streaming tool deltas.** Its tool hooks operate
  around assembled tool executions.
- **pi has `tool_call` and `tool_result` events**; whether pi exposes partial
  deltas is **unverified — to verify**. Until verified, the pi adapter is
  designed as pre-execution-only, identical to OpenCode's.

Adapter-side hooks are still required as a second line of defense for
non-stream decisions (a tool the proxy allowed but phase policy forbids at
execution time, or a host that bypassed a rule):

- **OpenCode:** tool hook `execute.before` — can block before execution.
- **pi:** `tool_call` event handler returning `{ block: true }`.

### 10.2 Gate behavior and mid-stream rewrite

The proxy applies the DESIGN.md §6.7 preflight lifecycle to the live stream:
partial tool-name check, partial-argument check (path-complete write targets,
unambiguously forbidden commands), full validation on complete arguments.

**Spike result (llama.cpp b10934, `docs/superpowers/spike-findings/`):**
tool-call arguments arrive incrementally (observed 6 fragments totalling 24
chars); the tool **name arrives in the same chunk as the first argument
fragment** — never name-before-arguments as a separate chunk, but the name is
available before any substantive argument content; reasoning streams
separately as `reasoning_content` deltas. **Early interruption is therefore
feasible on llama.cpp**, and the unknown-tool check happens at that first
name-bearing chunk. Servers whose streams cannot support this fall back to the
§10.3 two-stage protocol (Ollama / LM Studio: untested — servers absent).

When the gate trips **mid-stream**, the proxy:

1. **cancels the upstream generation** (aborts the request to the model
   server), and
2. **rewrites the response into a well-formed one** delivered to the host:
   either a synthetic tool call to a **harness-owned `harness_notice` tool**
   (a no-op tool whose arguments carry the interruption explanation), or an
   assistant message carrying the correction text.

Either way the host sees a valid, complete response — never a truncated
tool-call fragment — and the model sees the concise correction from the
DESIGN.md §6.7 examples on the next turn. The forbidden side effect never
starts: the tool call is never forwarded for execution, and the adapter hooks
would block it again if it somehow were.

### 10.3 The SPIKE (delivery step 1, throwaway) — **executed 2026-09-21**

Results in `docs/superpowers/spike-findings/findings.md`; fixtures in
`docs/superpowers/spike-findings/fixtures/` (streams.jsonl, discovery.jsonl,
reasoning.jsonl) are the corpus for the fake streaming provider (§17).

**First implementation step of the whole project.** A throwaway spike records
real tool-call streams from **llama.cpp, Ollama, and LM Studio** to answer
DESIGN.md open question 1: **which servers emit tool-call arguments
incrementally** (name-before-arguments, argument fragments, reasoning deltas),
and how cancellation behaves on each. The spike also confirms the discovery
probe endpoints of §8 empirically. Recorded streams become the **fixture corpus
for the fake streaming provider** used in delivery step 3 and the runtime tests
(§17).

**Fallback:** for any server whose stream cannot support early interruption,
the gate falls back to the **two-stage protocol of DESIGN.md §8.3** (stage 1:
model selects the tool; preflight; stage 2: model generates arguments),
implemented in the proxy so hosts don't notice. The extra model turn is the
accepted cost on those servers.

## 11. Task lifecycle

Unchanged from DESIGN.md §7: **Prepare** (validate root, detect Git, capture
baseline + fingerprint, resolve policy profile, create task dir, build
workspace, redact secrets) → **Run** (launch proxy, then runtime; compile tool
list; stream through the gate; enforce full policy pre-execution; record every
request and decision; concise corrections) → **Freeze** (stop actions, clean up
child processes, extract exact patch + manifest) → **Verify** (§9.9) →
**Promote / export / discard** (§9.10).

## 12. Small-model layer

All mechanisms below live mostly in `proxy` and the profile data files. **Every
mechanism is individually switchable** (config §7, per-profile, and per-bench
run) and **judged by benchmark ablation** (§15). Defaults: all on.

### 12.1 Model profiles

Profiles are **data files**, user-overridable in `tinystrap.toml`. A profile
binds a model family (matched from the discovered model id, §8) to: tool set,
edit-tool choice, thinking/reasoning settings (§12.6), repair strictness, and
context-budget parameters. **Weaker models get simplified tool sets** — e.g. a
single forgiving edit tool instead of separate `edit`/`write`/`apply_patch` —
to shrink the action space. Unknown models get a conservative default profile;
`doctor` shows the selected profile and why.

### 12.2 Tool-call repair

The proxy repairs malformed tool calls before they reach the host: invalid or
truncated JSON, wrong argument names (mapped via per-tool alias tables),
near-miss tool names (`read_file` → `read` by edit distance against the
registry). **Every repair is logged** as an audit event with before/after
digests, and repair counts are a benchmark metric — a repair that fires often
is a signal to fix the profile or prompt, not to be proud of the repairer.

### 12.3 Context budgeting

Sized from the **discovered context length** (§8), never hardcoded. Mechanisms:
turn-history truncation, file slices instead of whole files in read results,
conversation compaction, **condensing of test/build output** (keep failures
and summaries, drop boilerplate), and an **automatic repo map injected at task
start**.

Spike caveat: the observed llama.cpp server reports `n_ctx` 128000 and
`total_slots` 4. Whether 128000 is the **total** or the **per-slot** context
is undetermined (Appendix A10); budgeting must not assume either, and
discovery includes a step to determine it (e.g. slot-info probe), marked **to
verify**.

### 12.4 Edit assistance

- A **read-before-edit denial includes the relevant file slice** around the
  target, so the model gets the information it needs in the same turn.
- A failed exact-match edit: try **normalized matching** (whitespace/line-ending
  insensitive); if that fails, apply a **fuzzy match only if unambiguous**;
  otherwise return the **closest lines** from the file so the model can retry
  precisely.
- After each successful edit, a **fast syntax/lint check** runs on the edited
  file and the **first error** (if any) is shown immediately — not a full
  verification pass.

### 12.5 Guidance

- A **required short plan checklist** at task start, tracked by the harness
  (the model must produce it; the harness tracks item completion state).
- **Per-turn tool cards**: compact reminders of the currently available tools
  and their key constraints, injected per turn.
- **Stall detection**: repeated identical calls, re-reading the same file
  repeatedly, edits that revert previous edits. Escalation: **nudge → forced
  replan → stop**.

### 12.6 Reasoning control

- **Phase-based thinking:** reasoning/thinking mode **on for planning and
  failure diagnosis**, **off or short for mechanical steps** (file reads,
  simple edits). Controlled via per-request sampling parameters and prompt
  directives, per profile.
- **Loop detector on the reasoning stream**, using multiple signals:
  1. repetition — n-gram overlap / near-identical sentences;
  2. repeated conclusion — the same "therefore" statement recurring;
  3. falling novelty — new-sentence ratio declining over the stream;
  4. no commitment — thinking continues without producing an action;
  5. cross-turn repetition — this turn's reasoning repeats a prior turn's.

  Signals are **combined into a score**, not acted on individually — **except
  verbatim repetition**, which is decisive on its own.
- **Escalation ladder:** observe and log only → soft nudge injected into
  context → **close reasoning on strong evidence** (force the model out of
  thinking mode) → **very high absolute token backstop** (hard cap, safety
  net). **Long-but-progressing thinking is never cut** — the score, not length,
  drives everything before the backstop.
- **Every intervention is logged with its triggering signal values** — this is
  what makes ablation (§15) and debugging possible.
- Forced-close requires the model server to support **continuing generation
  after closing a reasoning block**. The SPIKE verified only **per-request**
  reasoning-off on llama.cpp b10934: `chat_template_kwargs:
  {"enable_thinking": false}` → normal content, zero reasoning chunks (the
  generic `thinking: {"type": "disabled"}` field was rejected/ignored).
  **Mid-stream forced reasoning-close (interrupt then resume) was NOT tested
  and stays to verify**; the ladder's "close reasoning on strong evidence"
  step depends on it. Where unsupported, the ladder stops at "soft nudge" and
  the backstop remains.

### 12.7 Pinned notes

A small, **capped** harness tool for **decisions, current plan, and confirmed
facts**. Notes **persist across turns and survive compaction** — chat templates
often drop prior reasoning, so the harness re-injects pinned notes after
compaction and at task resume. The cap forces the model to keep notes short.

### 12.8 Deferred until measured

**Knowledge snippets** (injected library/language crib sheets) and
**checkpoint-and-retry** (snapshot-and-retry on failure) are deliberately not
in v1: plausible, unmeasured aids. They enter only with ablation evidence or a
specific benchmark-identified gap.

## 13. OpenCode and pi integration details

### 13.1 OpenCode adapter

Uses the plugin API for: `session.context`-style tool-set filtering before
requests; permission evaluation (allow/ask/deny) before execution; the tool
hook **`execute.before`** as the blocking second line; tool-call logging;
result shaping; harness intervention messages. Base URL points at the proxy.
(Plugin surface per DESIGN.md references; hook names as documented — the
`execute.before` name itself is **to verify** against the OpenCode version
pinned at implementation time.)

### 13.2 pi adapter

Registers a **`tool_call`** event handler returning **`{ block: true }`** to
deny, and a `tool_result` handler for logging/shaping. Base URL points at the
proxy. Whether pi exposes **partial streaming deltas** is **to verify**; until
verified the adapter assumes it does not, and all early interruption comes
from the proxy.

### 13.3 Event mapping

Both adapters translate runtime events into the shared `HarnessEvent` model
(§13.4 / DESIGN.md §10) so audit and bench data are host-independent.

### 13.4 Event and audit model

Unchanged from DESIGN.md §10: every significant action produces a
`HarnessEvent` (`tool_stream_started`, `tool_preflight`, `tool_interrupted`,
`tool_executed`, `tool_failed`, `workspace_frozen`, `verification_started`,
`verification_finished`, `promotion_requested`, `promotion_applied`,
`promotion_refused`), plus new kinds for this spec: `evasion_flagged`,
`tool_call_repaired`, `reasoning_intervention`, `discovery_completed`,
`script_rescanned`. No secrets or full sensitive arguments in logs — hashes,
redacted summaries, decision context.

### 13.5 Deployment modes

tinystrap runs standalone and inside other toolchains. **No host change is
required**: integration is entirely a model **base URL** pointing at the proxy
(§10) plus a **workspace** supplied to or created by the harness (§9.2).

**Mode 1 — standalone CLI (default).** The harness owns the whole task
lifecycle: create the task, launch the agent, run verification, control
promotion (§11). The workspace comes from the **independent-clone** provider
(§9.2). This is tinystrap used as its own tool.

**Mode 2 — host-integrated.** OpenCode or pi runs — launched by the harness or
by another orchestrator — with its model base URL pointed at the tinystrap
proxy, so the streaming gate and the policy engine apply to whatever the host
does. The workspace is independent-clone when the harness launches the host,
or **external** when another orchestrator supplies the directory.

**Mode 3 — inside AO (Agent Orchestrator).** An AO worker runs pi or opencode
configured with the proxy as its model endpoint, and AO passes its per-worker
git worktree to tinystrap as the **external** workspace (§9.2). Promotion uses
**open_pr** (§9.10), so the result appears in AO's own PR/CI/review/merge flow
and is tracked there like any other PR.

**Guarantees per mode.** Policy gate = deterministic policy before any side
effect; streaming preflight = mid-stream early interruption; workspace
isolation = structural workspace isolation; verification = fresh-workspace
re-verify; promotion control = human-gated, broker-only promotion; OS
containment = OS-level sandbox (§9.8):

| Guarantee            | 1. Standalone | 2. Host-integrated                          | 3. Inside AO            |
| -------------------- | ------------- | ------------------------------------------- | ----------------------- |
| Policy gate          | yes           | yes                                         | yes                     |
| Streaming preflight  | yes           | yes                                         | yes                     |
| Workspace isolation  | yes           | partial (structural only when the harness owns the workspace) | no (external: not structural) |
| Verification         | yes           | yes                                         | yes                     |
| Promotion control    | yes           | yes                                         | yes                     |
| OS containment       | no (deferred, §9.8) | no (deferred, §9.8)                    | no (deferred, §9.8)     |

In modes 2 and 3 with an external workspace, git-metadata isolation is **not
structural** and rests on the policy engine denying git push, branch deletion,
ref updates, and other git writes that reach outside the workspace, plus the
credential-scrubbing rules (§9.2). Nothing in this section has been tested
against a real AO worker yet — **to verify** (Appendix A11).

## 14. Error handling

| Failure                                | Behavior                                                                                     |
| -------------------------------------- | -------------------------------------------------------------------------------------------- |
| Server unreachable / model missing     | Task does not start; **`tinystrap doctor` explains exactly what was probed** and what failed. |
| Proxy failure mid-task                 | **Task stops safely**: agent is halted, no promotion happens, **workspace is kept** for inspection and resume-from-baseline. |
| Verification failure                   | Diagnostics go **back to the model** for another attempt (bounded by task limits), or the failed patch is **exported** for human inspection. |
| Drift (protected project changed)      | **Promotion stops**; user is offered **rebase or review** of patch vs. new state.             |
| Runaway task                           | **Wall-time, process-count, and output-size limits** enforced by the supervisor/sandbox; on trip: freeze, clean process tree, keep artifacts. |

## 15. Benchmarks

Three tiers, always run with the **full harness on**, with an **ablation switch
per mechanism** (§12 and the policy analyzers) so each aid's contribution is
measurable.

1. **Own fast task suite** — run **daily**. Small, local, fast; covers normal
   coding tasks **and safety behavior**: denials, evasion attempts, drift
   handling, promotion correctness. This is the regression net for the harness
   itself, not just the model.
2. **Aider Polyglot** — the main external comparison.
3. **Terminal-Bench** — occasionally (cost below).

**Metrics per model+profile:** resolve rate, turns, tokens, wall time,
denials, repairs, evasion flags, reasoning interventions.

Reference numbers (from the little-coder README, **approximate — to verify**):

| Benchmark                | Qwen3.5-9B | Qwen3.6-35B-A3B |
| ------------------------ | ---------- | --------------- |
| Aider Polyglot           | 45.6%      | 78.7%           |
| Terminal-Bench 2.0       | 24.6%      | 9.2%            |

Caveat carried forward: those reference runs used **accept-all mode**, so they
do **not** exercise safety features; comparing tinystrap's safety-on scores to
them measures a different configuration and must be labeled as such.
Terminal-Bench **Core** took **~6h50m for 80 tasks**, which is why public-bench
runs are **periodic**, not daily. Python drivers for public benches live in
`bench` (§6).

## 16. Milestones (ordered) and delivery order

Milestones M1–M6 from DESIGN.md §12 are kept as the build order. The delivery
plan interleaves the spike, proxy, and bench work:

1. **SPIKE** (§10.3) — throwaway. Record real streams from llama.cpp, Ollama,
   LM Studio; confirm discovery probes (§8); check reasoning-continuation
   support (§12.6). Output: fixture corpus + answers, not product code.
2. **M1 + M2 — core lifecycle and policy.** Task lifecycle, snapshot (§9.2)
   with the **WorkspaceProvider interface** (`independent-clone` and `external`
   providers), patch extraction, export-only mode; tool registry, phase
   capability profiles, path policy, write/read-before-edit guards, **effect
   classifier, shell + Python analyzers, script provenance, evasion
   detector**, structured denials. **Config (§7) and `doctor` (§8.1) ship
   here** — nothing lands before the one-file config and doctor exist.
3. **Proxy + M5 streaming gate + small-model layer.** Provider-stream proxy
   (§10), early interruption and mid-stream rewrite, fallback two-stage
   protocol, and §12 mechanisms — all exercised against a **fake streaming
   provider that replays the SPIKE-recorded streams** (no real GPU needed).
4. **M3 — adapters.** OpenCode first, then pi (§13). Thin: base URL +
   blocking hooks + filtering + logging.
5. **M4 — verifier + promotion broker.** Clean verifier workspace, patch
   integrity, auto-detected verify commands (§9.9), drift detection, one-key
   approve flow with rollback checkpoint and post-apply checks, and the
   **`open_pr` mode** (task-branch push + PR creation after approval) (§9.10).
6. **Bench harness** — **starts alongside step 3**, not after it: the
   small-model layer needs ablation data while it is still being tuned. Own
   suite first, then Aider Polyglot driver, then Terminal-Bench driver.
7. **M6 — sandbox backends.** First release: isolated workspace, hidden
   credentials, scrubbed env, resource limits, process-tree cleanup, pluggable
   backend interface (§9.8). Low-privilege-user / Windows Sandbox / WSL2 or
   container backends follow.

## 17. Testing strategy

Unchanged from DESIGN.md §11 (unit: registry, capability compilation, path
normalization, boundary checks, write/read-before-edit guards, shell
tokenization, redirection/heredoc detection, partial tool-call parsing,
interruption messages, hashing, patch extraction, drift detection;
integration: the ten listed adversarial-model scenarios, verifier escape
rejection, drift refusal, promotion preserving human edits), extended with:

- **policy unit tests for effect classification** — every listed route
  (`write`, `echo >`, `sed -i`, `tee`, `cp`, `python open()`, `git checkout`)
  produces the same effect record and hits the same rule;
- **evasion tests** — denied effect signature, then the same effect via a
  different tool ⇒ flagged, escalation ladder observed;
- **provenance tests** — write clean script, mutate it, execute ⇒ re-scan
  fires and the decision changes with content;
- **fail-closed tests** — unparseable/obfuscated shell and Python ⇒ deny/ask,
  never allow;
- **proxy replay tests** — the fake streaming provider replays the SPIKE
  corpus: unknown tool interrupted before arguments finish; existing-file
  write interrupted before content finishes; allowed calls execute only after
  final validation; interrupted responses are well-formed (§10.2);
- **small-model ablation tests** — repair cases from the corpus, budget
  behavior at synthetic small context lengths, fuzzy-edit ambiguity handling,
  loop-detector scoring on recorded reasoning streams (looping ⇒ intervention
  at the expected ladder rung; long-but-progressing ⇒ no intervention);
- **bench safety-tier tests** — the daily own-suite includes denial, evasion,
  drift, and promotion scenarios with expected harness outcomes (§15 tier 1).

## 18. Open questions

Each has a recommended default; none blocks the build.

1. **Which local servers stream tool-call arguments incrementally?**
   Resolved empirically by the SPIKE (§10.3); per-server answer unknown until
   then. *Default:* two-stage fallback (§8.3) for anything that doesn't
   stream.
2. **Windows isolation mechanism for the sandbox (DESIGN.md Q3).**
   *Default:* ship the backend interface with the workspace/credential/env
   isolation release; evaluate low-privilege-user vs. Windows Sandbox vs.
   WSL2/container on toolchain compatibility after M6's first release.
3. **Network policy (DESIGN.md Q4).**
   *Default:* network disabled; package-registry allowlists via a controlled
   proxy are a later, explicitly-configured opt-in.
4. **Model editing files generated during the task, not in the baseline
   (DESIGN.md Q8).**
   *Default:* generated files inside the task workspace are freely editable;
   they appear in the patch as new files and are subject to the same path and
   secret policy at promotion.
5. **Does pi expose partial tool-call deltas?** *Default:* assume not
   (pre-execution-only adapter); revisit if verification shows otherwise.
6. **Does each server support forced reasoning-close (continuation after
   closing a thinking block)?** *Default:* ladder stops at soft nudge where
   unsupported.
7. **`harness_notice` tool vs. correction-only assistant message** for
   mid-stream rewrites: which small models follow each more reliably.
   *Default:* `harness_notice` (a tool call is harder for a weak model to
   ignore than prose); decide per profile from bench data.
8. **Secret-detection ruleset** for baseline capture (which patterns/paths
   count as secrets). *Default:* a conservative bundled ruleset (`.env*`,
   `*.pem`, `id_*`, credential stores, token patterns) plus user
   extend/exclude in config; false-excludes are recoverable since the
   protected project is never modified.
9. **Does AO expose a per-worker model-endpoint setting for pi/opencode?**
   The inside-AO mode (§13.5) needs the proxy URL configured per worker.
   *Default:* yes — a per-worker model/base-URL override in the AO worker
   profile. **to verify** against a real AO worker.
10. **How does the proxy learn the current phase/task when the host owns the
    lifecycle in external mode?** *Default:* the host hands the task/phase in
    explicitly (e.g. `tinystrap task attach`) and the proxy reads the
    `.tinystrap/` state inside the adopted workspace. **to verify** against a
    real host integration.

## 19. Recommended defaults (supersedes DESIGN.md §14 where changed)

```text
Protected project writes:       never direct from the model
Task workspace:                 disposable, read/write
Workspace provider:             independent-clone by default; external only when
                                configured (host-supplied directory; no
                                structural git isolation)
Default promotion mode:         apply after diff+report, one-key approve
                                (export_patch, commit_task_branch and open_pr
                                remain modes)
Automatic push:                 no push without explicit per-task approval;
                                the model never pushes (open_pr pushes only the
                                task branch, per-task approved, never force)
Config:                         tinystrap.toml + optional user defaults; nothing else
Task state:                     .tinystrap/ (disposable)
Server/model/context:           discovered, zero input; config overrides
Network:                        disabled
Credentials:                    hidden
Unknown tools:                  interrupt immediately
Phase-denied tools:             interrupt immediately
Forbidden arguments:            interrupt before execution
Unclassifiable/obfuscated:      deny or ask (fail closed)
Existing-file write:            redirect to edit/apply_patch
Verification:                   fresh workspace, auto-detected checks
Source drift:                   refuse blind promotion; offer rebase/review
Repeated denial:                suppress tool, inject correction, stop after repeats
Evasion attempt:                flag, escalate strip → correction → stop
LLM judge:                      off in v1 (tighten-only when enabled)
Small-model layer:              all mechanisms on, each ablation-switchable
Reasoning:                      scored loop detection; long-but-progressing never cut
```

## 20. References

All DESIGN.md §15 references stand (little-coder README/changelog; OpenCode
providers, plugin hooks, permissions docs), plus:

- Aider Polyglot benchmark (external comparison, tier 2)
- Terminal-Bench (occasional external comparison, tier 3)
- llama.cpp server HTTP API docs — `/props` endpoint (**to verify**)
- Ollama API docs — `/api/tags`, `/api/show` (**to verify**)
- LM Studio local server docs — model listing endpoints (**to verify**)
- pi plugin docs — `tool_call` / `tool_result` events

## Appendix A — "to verify" register

Statuses updated 2026-09-21 from the executed spike
(`docs/superpowers/spike-findings/findings.md` + `fixtures/`). Observed
server: llama.cpp b10934, model `Qwen3.8-Flash-Next-AP-Q4_K_M`,
`LAN-HOST:8080` (LAN) — recorded spike evidence only, not a default.

| # | Claim | Where | Status |
| - | ----- | ----- | ------ |
| 1 | OpenAI-compatible `/v1/models` yields usable model list (context length usually absent) | §8 | **Confirmed for llama.cpp** — `data[]` entries carry `owned_by: "llamacpp"` and `meta.n_ctx` = 128000; the "context length usually absent" parenthetical is **refuted for llama.cpp**, kept open for other servers. Evidence: `fixtures/discovery.jsonl:2` |
| 2 | llama.cpp `/props` yields model + n_ctx | §8 | **Confirmed with corrected key paths** — model = `model_alias` (or `model_path`), n_ctx = `default_generation_settings.n_ctx`; also `build_info`, `model_ftype`, `total_slots`, `is_sleeping`, `chat_template_caps` (`supports_tool_calls`, `supports_preserve_reasoning`, …). Planned top-level `default_model`/`n_ctx`/`context_size` keys refuted. Evidence: `fixtures/discovery.jsonl:1` |
| 3 | Ollama `/api/tags` + `/api/show` yield models + context window | §8 | **Open** — server not available during the spike |
| 4 | LM Studio model-listing endpoint shape and context length | §8 | **Open** — server not available during the spike |
| 5 | Server-type identification on a probed port | §8 | **Confirmed for llama.cpp** by response shape (`owned_by: "llamacpp"` + `meta`; `/props` `build_info`); a non-llama.cpp 404 responder on :8080 was correctly excluded. Ollama / LM Studio identification: open |
| 6 | Whether pi exposes partial streaming tool-call deltas | §10.1, §13.2 | Open (not exercised by the spike) |
| 7 | OpenCode `execute.before` hook name/semantics in the pinned version | §13.1 | Open (docs at pin time) |
| 8 | Server support for forced reasoning-close (continuation) | §12.6 | **Partial** — per-request thinking-off verified on llama.cpp via `chat_template_kwargs {"enable_thinking": false}` (zero reasoning chunks; generic `thinking: {"type": "disabled"}` rejected/ignored). **Mid-stream forced close (interrupt then resume) NOT tested — stays open**; the loop-detector's "close reasoning" escalation step (§12.6) depends on it. Evidence: `fixtures/reasoning.jsonl:1` |
| 9 | little-coder reference scores: Polyglot 45.6% / 78.7%; TB 2.0 24.6% / 9.2%; TB-Core ~6h50m/80 tasks | §15 | Open (re-read README + own runs) |
| 10 | **New (spike):** is the reported `n_ctx` (128000) the **total** or the **per-slot** context (observed `total_slots` 4)? | §8, §12.3 | **To verify** — discovery must determine it (e.g. slot-info probe / `GET /slots`) before context budgeting relies on the number; budgets must not assume either reading |
| 11 | **New (deploy modes):** does AO expose a per-worker model-endpoint setting for pi/opencode? | §13.5, §18 | **To verify** — nothing here has been tested against a real AO worker yet |
| 12 | **New (deploy modes):** how the proxy learns the current phase/task when the host owns the task lifecycle in external mode | §13.5, §18 | **To verify** — default: explicit host handoff (`tinystrap task attach`) plus `.tinystrap/` state |
