# tinystrap

tinystrap is a local coding harness for small and medium local models. A model
runs inside a disposable workspace; every tool call is checked by a
deterministic policy engine and a streaming proxy before it can touch files.
When the model finishes, the change set is re-verified in a fresh workspace,
and only a verified patch is promoted back to the real repository. The goal is
to make weaker local models safe and useful for real coding tasks without
trusting them not to misbehave.

## Status

Early development. The design is settled and the first implementation steps
have landed; the end-to-end loop is not yet runnable.

**What exists today**

- Full system design and implementation specs (`DESIGN.md`, `docs/`).
- Core packages: a deterministic tool-call policy engine, configuration, and
  workspace snapshot machinery (`packages/policy`, `packages/core`).
- A `tinystrap` CLI skeleton (`doctor`, `task new/export/cleanup`).
- A streaming proxy and small-model interaction layer, plus recorded spike
  fixtures from a real llama.cpp server (`docs/superpowers/spike-findings/`).

**What does not exist yet**

- Model adapters (host integrations for OpenCode and pi — thin plugins that
  point the host's model base URL at the tinystrap proxy).
- The verifier and the promotion broker.
- Sandbox backends.
- The benchmark harness.

## Requirements

- Node.js 20 or newer
- pnpm 12

## Commands

```sh
pnpm install
pnpm typecheck
pnpm test
```

## Documentation

- [DESIGN.md](DESIGN.md) — the system design.
- [Harness design spec](docs/superpowers/specs/2026-09-20-tinystrap-harness-design.md) — the detailed specification.

## Note

This repository was implemented with AI coding agents under human direction.
