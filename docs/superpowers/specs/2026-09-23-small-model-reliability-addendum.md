# Small-Model Reliability Addendum

**Status:** Draft

**Date:** 2026-09-23

**Extends:** [Harness design spec](./2026-09-20-tinystrap-harness-design.md)

## 1. Summary

The base design makes small models *safe*: policy gates, sandboxing,
verification, and promotion control contain what a weak model can do.
This addendum addresses the orthogonal axis — making weak models *correct*.

The premise is that existing coding harnesses (OpenCode, Claude Code, aider)
are built for large models. They assume the model can hold repo conventions,
API signatures, and its own error history in context, remember to verify
things, and operate query tools deliberately. Small models cannot. tinystrap's
inverse bet: **when the model is the weakest component in the loop, the
harness stops being plumbing and becomes the model's working memory and
prefrontal cortex.**

Everything below is deterministic. No feature in this addendum requires a
second model, statistical inference, or prose generation.

## 2. Principles (the tiny-hands contract)

1. **The model proposes, the harness decides.** *(authority — base design)*
2. **The model proposes in ignorance, the harness corrects silently.**
   *(knowledge — facts live in the policy engine; only violations reach the
   model's context)*
3. **Feedback is pushed, delta-filtered, and capped.** The model never asks
   for diagnostics, never wades through baseline noise, never receives more
   than a handful of lines.
4. **A round-trip saved is context earned; context spent is quality spent.**
   On small models, prompt minimization is a *quality* lever, not a cost
   lever: attention degrades with prompt bulk independently of token budgets.
5. **Feedback strength sets promotion policy.** A project with no fast-check
   profile never earns `auto_promote`, and `doctor` says why.
6. **The model never holds what the harness can see.** The silent index, the
   just-in-time fact, and the silent rewrite are all instances of this rule.

Corollaries:

- **Tool surface follows the same law.** Few tools, tiny verbs, one obvious
  way per task. Every registered tool is a decision the model must make and a
  schema permanently in context. The capability compiler narrows by phase;
  the registry itself stays radically small. A `code_graph_query` tool is
  rejected not because graphs are bad but because holding a query strategy in
  tiny hands is bad.
- **No prose guides.** Any guidance text that no toolchain emitted is a
  hallucination delivered to a hallucinating model. Fact content must be
  traceable to a parsed file.

## 3. Corrective feedback: three timing tiers

### 3.1 Tier 1 — mid-generation (streaming)

Interrupt only on failures that *cannot be rescued by the next token*:

- **Irrecoverable parse state.** Tree-sitter parses partial input
  incrementally with error recovery. Unterminated string literals, unbalanced
  brackets, and equivalent states where no continuation yields a parse are
  interrupted at the stream gate (the Milestone 5 gate, extended from policy
  predicates to syntax predicates).
- **Size heuristics.** A `write` whose content length grossly exceeds the
  target file's size (e.g., >10x) is interrupted before completion.

Everything else mid-generation: let it finish, fail well in the tool result.
Mid-stream semantic feedback is a trap — it wastes generated tokens and
derails fragile generations.

### 3.2 Tier 2 — inside the tool result (the primary surface)

After `edit`/`write` executes and before the tool result returns, the harness
runs fast analyzers on the touched paths only:

1. Tree-sitter parse → syntax errors with line numbers (milliseconds).
2. A watch daemon started by the supervisor at task launch (see §4). The
   harness debounces briefly after the daemon settles, correlates new
   diagnostics to the edited file, and appends them to the tool result.
3. Import-graph test scoping: run the test file mapped to the changed source
   file synchronously when it completes under a configured budget (~2 s);
   otherwise promote it to Tier 3.

**Required: diagnostic deltas, not diagnostic sets.** The tool result carries
"your edit introduced 2 new errors: …", computed as a set diff of diagnostic
fingerprints against the pre-edit snapshot, capped at ~5 lines. Baseline
noise from a pre-existing broken build teaches a small model nothing and
consumes its context.

### 3.3 Tier 3 — async background events

The full test suite and full typecheck run continuously in the background.
On transition to red, the harness injects a synthetic one-line message at the
next safe boundary (after the current tool result). Never blocks the model;
never races its stream.

## 4. Feedback provider profiles (the language seam)

Feedback strength is a per-project capability axis, resolved by `doctor` and
recorded in task metadata. The core speaks one protocol; language support
lives in off-the-shelf toolchain adapters, not in tinystrap code.

| Tier | Mechanism | Cost | Examples |
| ---- | --------- | ---- | -------- |
| S | LSP daemon | 0.5–4 GB RAM | tsserver, pyright, rust-analyzer, gopls |
| C | CLI check-on-edit | ~50 MB, 1–5 s | `tsc --noEmit --incremental`, `ruff check`, `mypy --follow-imports=skip` |
| P | tree-sitter parse only | ~30 MB, zero config | every bundled grammar |
| 0 | none | — | unknown toolchains |

Rules:

- **Tier P is always on**, every language, no configuration.
- **Tier S is opt-in and hardware-honest.** LSP daemons compete with the
  inference server for RAM on exactly the machines small-model users own.
  The supervisor must not start a daemon that jeopardizes inference.
- A project's resolved tier is recorded in `metadata.json` and visible in
  `doctor` output. Tasks in Tier 0 run visibly in **low-feedback mode**.
- MVP ships exactly two reference profiles (TypeScript, Python). The seam is
  public; breadth is not a goal.

**Policy coupling:** feedback strength gates promotion mode. `auto_promote`
requires Tier S or C with a passing fast-check profile. Tier P/0 projects cap
at `apply` with review, or `export_patch` during early development.

## 5. Prescriptive layer: facts as policy, not prompt

Small models do not self-verify; they assume they know. The prescriptive
layer pushes ground truth into the loop at the moment of action so errors
never form. All content is parse-derived.

### 5.1 The fact card is harness state, not prompt content

At task start, the harness parses manifests (`package.json`,
`pyproject.toml`, CI config, test config) into a structured fact record:
package manager, test runner, test path conventions, entry points, build
commands. This record configures the policy engine. It is **not** injected
into the prompt.

### 5.2 Compile facts into rewrites

The policy engine's `rewrite` effect is the primary consumer of facts:

- Model emits `npm test` in a pnpm repo → rewrite to `pnpm test`.
- Model writes `tests/foo.spec.ts` in a repo using `tests/**/*.test.ts` →
  rewrite the write target to the repo convention.

Rewrites are never invisible: the tool result shows the command/path that
actually ran plus a one-line note ("rewritten: repo uses pnpm"). This keeps
the model's world-model consistent at a cost of ~12 tokens at the exact
relevant moment.

Facts that cannot be rewritten become one-line corrections at violation
time. Either way, the model never learns the convention up front and never
spends context on it.

### 5.3 Enforced reality in tool results

The `edit` result always echoes the real current lines around the edit
region. The model can never act on a stale mental image of a file, because
the truth is always the last thing it read. This flips the read-before-edit
guard from pure policy into pedagogy at no extra round-trip cost.

### 5.4 Real signatures at call sites (post-edit first)

After an edit, diff the new code for references to project symbols; attach
their actual signatures (from the index, §6, or LSP hover at Tier S) to the
tool result, capped and delta-filtered as in §3.2. Mid-stream signature
attachment is a Milestone-5-era refinement; post-edit is trivial and ships
first.

## 6. The silent index

The index serves the harness, not the model. The model receives targeted
one-line answers derived from the index, never raw query results.

### 6.1 Substrate choices (open source, evaluated)

- **Tree-sitter** — universal *syntax* layer. One library, ~100+ language
  grammars, incremental, tolerant of broken/partial code. Provides symbols,
  definitions, intra-file references, structural matching, code chunking,
  and the Tier-P feedback checks. This is the always-on dependency.
- **SCIP** — universal semantic index *format* (protobuf schema) with
  per-language emitters (`scip-typescript`, `scip-python`, rust-analyzer
  native export). Discovery-based: if the project's toolchain can emit a
  SCIP index (or the user opts in), the harness loads it for cross-file
  definitions, references, and signatures. The harness does not run heavy
  indexers by default.
- **Semgrep / Comby** — multi-language AST search/rewrite, used as *policy*
  tools (detect `eval`, detect test-skip injection in a patch), not as
  context providers.

Rejected: Kythe, Glean (datacenter-grade, non-starters locally); any
"single binary, all languages, semantic" claim (semantics requires the
language's type system — every real semantic indexer is the compiler, the
language server, or a wrapper around one).

### 6.2 Anti-pattern: the queryable graph

Exposing the index to the model as a query tool is the popular design in
agent tooling and is wrong here: small models waste turns fumbling query
tools and blow context on 40-result reference lists. The harness asks the
graph one targeted question and injects one line.

## 7. Loop-breakers and state recovery

- **Green checkpoints.** Snapshot every state that passes the fast check
  (§3.2 analyzers, scoped tests). Track diagnostic counts per turn.
- **Flap detection.** Two consecutive edits that do not reduce the error
  count, or the same file edited N times without progress → stop feeding
  corrections, roll back to the last green checkpoint, inject a one-line
  summary: "reverted to state before your last 3 edits; current errors: …".
- This complements the base design's repeated-denial tracking, which handles
  policy loops; this handles competence loops.
- Baseline discard remains the last resort, not the first.

## 8. Reliability amplifiers

### 8.1 Grammar-constrained tool calls

The proxy owns the model stream; local servers (llama.cpp, vLLM) support
GBNF/JSON-schema constrained decoding. Constraining tool-call output at
decode time eliminates malformed-JSON failure before it exists — a larger
reliability win per unit work than post-hoc detection, and it sits exactly
where the proxy already lives.

### 8.2 Parallel sampling with deterministic verification

Disposable workspaces plus the fresh verifier make N-way parallel attempts
safe and cheap: run the same task in N workspaces, verify all patches,
promote the first that passes. Reliability by brute force — a model with 20%
per-attempt success reaches ~67% with five attempts. This is the highest
leverage idea in this addendum and the one no interactive harness can copy.
Costs: wall-clock/GPU, and a tiebreak policy when multiple patches verify
(recommended: smallest diff, then earliest verified).

### 8.3 Test-gaming detection

Small models "pass" tasks by editing tests, weakening assertions, or adding
skips. The verifier treats changes under `tests/`, snapshots, or test config
as a distinct verification class: diffed separately, flagged in the report,
and AST-checked (Semgrep-class rules) for skip/xfail/assert-removal
patterns. A patch that passes by mutating the contract is a false positive
in the promotion pipeline and must not promote without explicit resolution.

## 9. KV-cache discipline (proxy responsibility)

Prefix KV-cache reuse (llama.cpp, vLLM) makes prefill free for byte-stable
prefixes. The proxy enforces cache-prefix discipline:

- Stable region: system prompt → fact-derived policy configuration → tool
  schemas. Byte-stable for the task's lifetime; all dynamic content appended
  at the tail.
- **Known collision:** the capability compiler changes the tool list between
  phases, busting the entire prefix. Mitigations: order tools so phase
  changes are append-only where possible; accept at most one bust per phase
  transition; measure.
- The proxy reports cache-hit rate as a first-class metric.

## 10. Benchmark implications

The benchmark harness measures small-model economics, not big-model ones:

- **Turns-to-solve** and **tokens-per-solved-task** are first-class metrics
  alongside pass rate.
- A feature that lowers pass rate slightly but sharply reduces turns may be
  a net win at 4k–8k context (where the alternative is compaction death) and
  a loss at 128k. Report per-context-budget curves.
- Feedback tier is a benchmark dimension: the same task suite under Tier P
  vs Tier C vs Tier S quantifies exactly what the feedback layer buys.

## 11. Non-goals (reaffirmed and added)

- Strong-model-plans / weak-model-executes orchestration. Turns tinystrap
  into a two-model orchestrator and defeats the point.
- Auto-generated repo maps, architecture summaries, or convention prose.
- Queryable code-graph tools for the model.
- Bundling language toolchains into the installer (PATH + `doctor` checks
  instead).
- Statistical or model-based relevance ranking of context.

## 12. Open questions

1. How should phase transitions be ordered to minimize KV-cache busts from
   the capability compiler?
2. Tiebreak policy for parallel sampling when multiple patches verify.
3. Resource budgeting: how does the supervisor decide whether the hardware
   can afford a Tier-S daemon alongside the inference server?
4. Should rewrite-able facts be surfaced to the user in `doctor` before the
   task starts ("I will rewrite npm→pnpm, test paths→…")?
5. Minimum viable feedback for Tier-0 projects: is Tier-P syntax checking
   alone worth injecting into tool results, or is silence kinder at that
   strength?
6. How should green checkpoints interact with the freeze/patch-extraction
   lifecycle when the model's final state is red but a green checkpoint
   exists?

## 13. Suggested milestone mapping

| Addendum feature | Fits existing milestone |
| ---------------- | ---------------------- |
| Tree-sitter Tier-P checks in tool results | M2 (policy engine) |
| Fact card → policy rewrites (§5.1–5.2) | M2 |
| Grammar-constrained tool calls (§8.1) | M3 (adapter) — candidate to pull earlier |
| Feedback provider profiles + Tier C daemons (§4) | new, after M4 |
| Green checkpoints + flap detection (§7) | new, after M4 (snapshot machinery exists) |
| Test-gaming verification class (§8.3) | M4 (verifier) |
| Streaming syntax interrupts (§3.1) | M5 (streaming preflight) |
| KV-cache discipline + metrics (§9) | M5 (proxy) |
| Parallel sampling (§8.2) | new, after M5 |
