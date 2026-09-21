# Spike: streams and discovery (THROWAWAY)

## THROWAWAY NOTICE

**All code under `spike/` is throwaway.** It is committed only so the run is
reproducible, then deleted when delivery step 3 (proxy + fake streaming
provider) lands. The **only artifacts intended to survive** are the recorded
fixtures under `docs/superpowers/spike-findings/fixtures/` and the findings
file `docs/superpowers/spike-findings/findings.md`. The fake streaming
provider in step 3 replays those fixtures; nothing imports spike code.

## Server defaults

Assumed default endpoints (overridable by environment variables; all
**to verify** empirically — that is part of what the spike measures):

| Server    | Base URL                          | Env override          |
| --------- | --------------------------------- | --------------------- |
| llama.cpp | `http://127.0.0.1:8080`           | `TS_SPIKE_LLAMACPP`   |
| Ollama    | `http://127.0.0.1:11434`          | `TS_SPIKE_OLLAMA`     |
| LM Studio | `http://127.0.0.1:1234`           | `TS_SPIKE_LMSTUDIO`   |

## How to run

From the repo root (Python 3.11+, stdlib only, no pip installs):

```bash
python -m spike.run_spike
```

What gets recorded:

- `docs/superpowers/spike-findings/fixtures/discovery.jsonl` — raw discovery
  probe responses (one JSON object per line: server, endpoint, status, body).
- `docs/superpowers/spike-findings/fixtures/streams.jsonl` — raw SSE streams
  from forced tool-call requests, plus per-stream summaries.
- `docs/superpowers/spike-findings/fixtures/reasoning.jsonl` — reasoning-close
  continuation probe results.
- `docs/superpowers/spike-findings/findings.md` — generated findings, manually
  reviewed and committed after the live run.

Servers that are not running are recorded as `not available`, never as
failures. Secret-looking values (`Authorization`, API keys, tokens, secrets)
are stripped from every recorded artifact.

**Fixtures survive; this code does not.**

## Tests

```bash
python -m unittest discover spike/tests -v
```
