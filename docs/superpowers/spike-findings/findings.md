# Spike findings: streams and discovery

Resolves spec Appendix A items empirically where servers were
available; absent servers are recorded as `not available`.

## Server availability at run time

- llamacpp: available — `http://LAN-HOST:8080` (LAN llama-server;
  build `b10934-acecd5603`, model
  `Qwen3.8-Flash-Next-AP-Q4_K_M.gguf` (IQ4_NL - 4.5 bpw), n_ctx 128000,
  4 slots — evidence: `fixtures/discovery.jsonl:1`)
- ollama: not available
- lmstudio: not available

Note: an unrelated listener on `127.0.0.1:8080` answered HTTP 404 to `/props`
and `/v1/models` during a pre-run smoke probe — a port responder is not a
llama.cpp server; shape-based discrimination (A5) caught it.

## Stream classification

| server | attempt | tool calls | classification |
| ------ | ------- | ---------- | -------------- |
| llamacpp | plain | True | incremental |
| llamacpp | required | True | incremental |

Stream observations (llamacpp, `fixtures/streams.jsonl:2` and `:4`):

- Tool-call **arguments arrive incrementally**: 6 fragments
  (`{`, `"city":"`, `San`, ` Francisco`, `"`, `}`) totalling 24 chars.
- The tool-call **name arrives in the same chunk as the first argument
  fragment** — never name-before-arguments as a separate chunk, but the name
  is available before any *substantive* argument content
  (`name_first_chunk` = 36 plain / 26 required, equal to the first arg chunk).
- **Reasoning streams separately** from content and tool calls:
  35 (plain) / 25 (required) `reasoning_content` deltas precede the tool call.
- `tool_choice: "required"` is accepted and behaves identically to plain
  (same incremental shape); both attempts recorded.

## Appendix A items

### A1: OpenAI-compatible /v1/models yields a usable model list

Status: **confirmed** (llamacpp). `GET /v1/models` → 200 with
`{"object": "list", "data": [{"id", "aliases", "tags", "object", "created",
"owned_by", "meta"}]}`; `meta.n_ctx` = 128000 is present on llama.cpp entries
(context length is *not* absent there, contrary to the spec's parenthetical).
Evidence: `fixtures/discovery.jsonl:2`. Ollama / LM Studio: not available.

### A2: llama.cpp /props yields model + n_ctx

Status: **confirmed with corrected key paths** (llamacpp). `/props` → 200.
The planned candidate keys are **refuted**: there is no top-level
`default_model`, `total_n_ctx`, `n_ctx`, or `context_size`. Actual paths:
model = `model_alias` (or `model_path`), n_ctx =
`default_generation_settings.n_ctx` (128000). Also exposed: `build_info`
(`b10934-acecd5603`), `model_ftype`, `total_slots`, `is_sleeping`, and
`chat_template_caps` (`supports_tool_calls`, `supports_object_arguments`,
`supports_parallel_tool_calls`, `supports_preserve_reasoning`,
`supports_reasoning_effort`, …) — directly useful for §12.1 profiles.
Evidence: `fixtures/discovery.jsonl:1`.

### A3: Ollama /api/tags + /api/show yield models + context window

Status: **not available** — no Ollama server was running on
`127.0.0.1:11434` during the run; nothing recorded.

### A4: LM Studio model-listing endpoint shape + context length

Status: **not available** — no LM Studio server was running on
`127.0.0.1:1234` during the run; nothing recorded.

### A5: Server-type identification on a probed port

Status: **confirmed** (llamacpp vs. unknown listener). Response-shape
fingerprinting works: llama.cpp is identified by `/props` returning
`build_info`/`model_alias`/`chat_template_caps`, and independently by
`/v1/models` entries carrying `owned_by: "llamacpp"` and a `meta` block
(`fixtures/discovery.jsonl:1`, `:2`). A non-llama.cpp listener on
`127.0.0.1:8080` returned 404 for both routes and was correctly excluded.
Identification of Ollama / LM Studio: not available (servers absent).

### A8: Forced reasoning-close continuation support

Status: llamacpp: **supported** — `chat_template_kwargs:
{"enable_thinking": false}` → HTTP 200, normal content, **zero reasoning
chunks** (`fixtures/reasoning.jsonl:1`); the generic
`thinking: {"type": "disabled"}` field was rejected/ignored and not needed.
Note: this verifies *closing* reasoning per-request; mid-stream forced-close
continuation (interrupt then resume) was not exercised by this probe.
ollama: not available; lmstudio: not available
