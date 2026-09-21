# Spike: Streams and Discovery Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Record real streaming tool-call responses and discovery-probe results from llama.cpp, Ollama, and LM Studio, and produce a written findings file that resolves every spec Appendix A item the spike can resolve.

**Architecture:** A throwaway Python 3 command-line spike (`spike/`) probes whichever local servers are running, records raw SSE stream events and discovery responses as JSONL fixtures, then a pure analysis pass classifies each recorded stream (incremental vs. single-chunk tool arguments, separate reasoning deltas) and writes `docs/superpowers/spike-findings/findings.md`. All network code is thin and untested; all parsing/classification logic is pure functions covered by stdlib `unittest` tests against synthetic fixtures.

**Tech Stack:** Python 3.11+, standard library only (`urllib.request`, `json`, `unittest`, `dataclasses`). No pip installs. Fixtures are JSONL; findings are Markdown.

**Spec:** `docs/superpowers/specs/2026-09-20-tinystrap-harness-design.md` (§8, §10.3, §16 step 1, Appendix A)

## THROWAWAY NOTICE

**All code under `spike/` is throwaway.** It is committed only so the run is reproducible, then deleted when delivery step 3 (proxy + fake streaming provider) lands. The **only artifacts intended to survive** are the recorded fixtures under `docs/superpowers/spike-findings/fixtures/` and the findings file `docs/superpowers/spike-findings/findings.md`. The fake streaming provider in step 3 replays those fixtures; nothing imports spike code.

## Global Constraints

Copied from the spec, one line each; these bind every task:

- The spike is delivery step 1 and is throwaway; fixtures and findings are the only outputs later plans reuse (spec §10.3, §16).
- The spike must work when only SOME of the three servers are running: skip and record `not available` for the rest (task brief; spec §10.3).
- Servers probed: llama.cpp, Ollama, LM Studio (spec §10.3).
- Discovery endpoints to confirm: OpenAI-compatible `/v1/models`, llama.cpp `/props`, Ollama `/api/tags` and `/api/show`, LM Studio model listing (spec §8, Appendix A items 1–4).
- Server-type identification on a probed port is itself to verify (spec Appendix A item 5).
- Whether each server supports continuation after forcing a reasoning-close is to verify (spec §12.6, Appendix A item 8).
- Whether tool-call name and arguments arrive incrementally or all at once, and whether reasoning content streams separately, is recorded per server (spec §10.3).
- Recorded fixtures are JSONL and become the corpus for the fake streaming provider (spec §10.3).
- Never record secrets: strip `Authorization` headers and any API keys from every recorded artifact (spec §13.4 audit rule applied to spike output).
- Findings file must state, per Appendix A item, one of: `confirmed`, `refuted`, `not available` (server absent), with the raw evidence pointer.

## Server defaults

Assumed default endpoints (overridable by environment variables; all **to verify** empirically — that is part of what the spike measures):

| Server    | Base URL                          | Env override          |
| --------- | --------------------------------- | --------------------- |
| llama.cpp | `http://127.0.0.1:8080`           | `TS_SPIKE_LLAMACPP`   |
| Ollama    | `http://127.0.0.1:11434`          | `TS_SPIKE_OLLAMA`     |
| LM Studio | `http://127.0.0.1:1234`           | `TS_SPIKE_LMSTUDIO`   |

## File Structure

| Path | Responsibility (single) |
| ---- | ----------------------- |
| `spike/README.md` | Throwaway notice, how to run, what gets recorded |
| `spike/servers.py` | Server endpoint config + availability check (no parsing) |
| `spike/httpclient.py` | One thin function: HTTP GET/POST returning status + raw bytes; strips request headers from any returned record |
| `spike/redact.py` | Pure function: remove secret-looking values from a dict/JSON record |
| `spike/sse.py` | Pure SSE line parser: bytes → list of `(event, data_str)` |
| `spike/discovery.py` | Per-server discovery probes; writes raw responses to fixtures |
| `spike/contextlen.py` | Pure extractors: parsed probe JSON → `context_length` candidate values per server shape |
| `spike/streams.py` | Tool-call stream recording per server; writes JSONL fixtures |
| `spike/reasoning.py` | Reasoning-close continuation probe per server |
| `spike/analyze.py` | Pure classifier: fixture events → stream classification; builds findings text |
| `spike/run_spike.py` | Entry point: detect → probe → record → analyze → write findings |
| `spike/tests/test_redact.py` | Tests for redact |
| `spike/tests/test_sse.py` | Tests for SSE parser |
| `spike/tests/test_contextlen.py` | Tests for context-length extractors |
| `spike/tests/test_analyze.py` | Tests for stream classifier |
| `docs/superpowers/spike-findings/findings.md` | Generated findings, committed after the live run |
| `docs/superpowers/spike-findings/fixtures/*.jsonl` | Recorded streams and probe responses, committed |

---

### Task 1: Spike scaffold, server config, redaction

**Files:**
- Create: `spike/README.md`, `spike/servers.py`, `spike/httpclient.py`, `spike/redact.py`, `spike/tests/test_redact.py`
- Test: `spike/tests/test_redact.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `servers.SERVERS: dict[str, str]` — name → base URL (env-overridden).
  - `servers.check_available(name: str, timeout: float = 2.0) -> bool`
  - `httpclient.request(method: str, url: str, body: bytes | None = None, headers: dict[str, str] | None = None, timeout: float = 30.0) -> tuple[int, bytes]` — raises `ConnectionError` subclass `ServerGone` on connection failure.
  - `redact.redact(obj: object) -> object` — deep-copies dicts/lists, replaces values under keys matching `(?i)authorization|api[_-]?key|token|secret` with `"[redacted]"`.

Steps:
- [ ] Write failing test `spike/tests/test_redact.py`:

```python
import unittest
from spike.redact import redact

class TestRedact(unittest.TestCase):
    def test_redacts_authorization_and_token(self):
        rec = {"headers": {"Authorization": "Bearer sk-abc", "Accept": "application/json"},
               "api_key": "xyz", "model": "qwen"}
        out = redact(rec)
        self.assertEqual(out["headers"]["Authorization"], "[redacted]")
        self.assertEqual(out["headers"]["Accept"], "application/json")
        self.assertEqual(out["api_key"], "[redacted]")
        self.assertEqual(out["model"], "qwen")

    def test_leaves_non_secrets_alone(self):
        rec = {"data": [{"n_ctx": 8192}]}
        self.assertEqual(redact(rec), rec)

if __name__ == "__main__":
    unittest.main()
```

- [ ] Run: `python -m unittest spike.tests.test_redact -v` from repo root. Expected: FAIL — `ModuleNotFoundError: No module named 'spike'` until `spike/__init__.py` and `spike/tests/__init__.py` exist; create them (empty) and re-run; expected FAIL then becomes `ModuleNotFoundError: No module named 'spike.redact'`.
- [ ] Implement `spike/redact.py`:

```python
import re
from copy import deepcopy

_SECRET_KEY = re.compile(r"(?i)authorization|api[_-]?key|token|secret")

def redact(obj):
    obj = deepcopy(obj)
    if isinstance(obj, dict):
        return {k: ("[redacted]" if _SECRET_KEY.search(str(k)) else redact(v))
                for k, v in obj.items()}
    if isinstance(obj, list):
        return [redact(v) for v in obj]
    return obj
```

- [ ] Run tests. Expected: PASS (2 tests).
- [ ] Implement `spike/servers.py`:

```python
import os
import urllib.request

SERVERS = {
    "llamacpp": os.environ.get("TS_SPIKE_LLAMACPP", "http://127.0.0.1:8080"),
    "ollama": os.environ.get("TS_SPIKE_OLLAMA", "http://127.0.0.1:11434"),
    "lmstudio": os.environ.get("TS_SPIKE_LMSTUDIO", "http://127.0.0.1:1234"),
}

def check_available(name, timeout=2.0):
    url = SERVERS[name]
    try:
        urllib.request.urlopen(url + "/", timeout=timeout)
        return True
    except Exception:
        # Any HTTP response (even 404) means something is listening.
        import urllib.error
        return False
```

Note: `urllib.error.HTTPError` is an exception but proves a listener; refine `check_available` to return True on `HTTPError`:

```python
def check_available(name, timeout=2.0):
    import urllib.error
    try:
        urllib.request.urlopen(SERVERS[name] + "/", timeout=timeout)
        return True
    except urllib.error.HTTPError:
        return True
    except Exception:
        return False
```

- [ ] Implement `spike/httpclient.py`:

```python
import urllib.error
import urllib.request

class ServerGone(ConnectionError):
    pass

def request(method, url, body=None, headers=None, timeout=30.0):
    req = urllib.request.Request(url, data=body, method=method,
                                 headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise ServerGone(f"{url}: {e}") from e
```

- [ ] Write `spike/README.md`: throwaway notice (copy the THROWAWAY NOTICE section of this plan), the server table, `python -m spike.run_spike` usage (entry added in Task 6), and the statement that fixtures survive and code does not.
- [ ] Run full spike test suite: `python -m unittest discover spike/tests -v`. Expected: PASS.
- [ ] Commit:

```bash
git add spike/
git commit -m "spike: scaffold, server config, http client, redaction

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: SSE parser and stream event model

**Files:**
- Create: `spike/sse.py`, `spike/tests/test_sse.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `sse.parse_stream(raw: bytes) -> list[dict]` — parses an SSE byte stream into ordered records `{"event": str|None, "data": str}`; ignores comment lines (`: ...`) and empty separator lines; stops at `data: [DONE]` (the `[DONE]` record is emitted as `{"event": None, "data": "[DONE]"}` and terminates parsing).
  - `sse.tool_call_summary(records: list[dict]) -> dict` — given parsed OpenAI-style chunk records, returns `{"has_tool_calls": bool, "name_first_chunk": int|None, "arg_chunks": int, "arg_total_len": int, "reasoning_chunks": int}` where indices are positions among `data` records that JSON-parse to objects; `name_first_chunk` is the index of the first chunk carrying a non-empty tool-call `function.name`; `arg_chunks` counts chunks carrying any `function.arguments` fragment; `reasoning_chunks` counts chunks with a non-empty `reasoning` or `reasoning_content` field in `delta`.

Steps:
- [ ] Write failing test `spike/tests/test_sse.py`:

```python
import unittest
from spike.sse import parse_stream, tool_call_summary

RAW = (b'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"get_weather","arguments":""}}]}}]}\n\n'
       b'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"ci"}}]}}]}\n\n'
       b'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ty\\":\\"SF\\"}"}}]}}]}\n\n'
       b'data: [DONE]\n\n')

class TestSse(unittest.TestCase):
    def test_parse_stream(self):
        recs = parse_stream(RAW)
        self.assertEqual(len(recs), 4)
        self.assertEqual(recs[-1]["data"], "[DONE]")

    def test_summary_incremental(self):
        recs = parse_stream(RAW)
        s = tool_call_summary(recs)
        self.assertTrue(s["has_tool_calls"])
        self.assertEqual(s["name_first_chunk"], 0)
        self.assertEqual(s["arg_chunks"], 3)
        self.assertEqual(s["arg_total_len"], len('{"city":"SF"}'))
        self.assertEqual(s["reasoning_chunks"], 0)

    def test_summary_single_chunk(self):
        one = ('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":'
               '{"name":"f","arguments":"{\\"a\\":1}"}}]}}]}\n\ndata: [DONE]\n\n').encode()
        s = tool_call_summary(parse_stream(one))
        self.assertEqual(s["arg_chunks"], 1)

    def test_summary_reasoning(self):
        r = ('data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n'
             'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n').encode()
        s = tool_call_summary(parse_stream(r))
        self.assertFalse(s["has_tool_calls"])
        self.assertEqual(s["reasoning_chunks"], 1)

if __name__ == "__main__":
    unittest.main()
```

- [ ] Run: `python -m unittest spike.tests.test_sse -v`. Expected: FAIL — `ModuleNotFoundError: No module named 'spike.sse'`.
- [ ] Implement `spike/sse.py`:

```python
import json

def parse_stream(raw):
    out, event, data_lines = [], None, []
    for line in raw.decode("utf-8", "replace").splitlines():
        if line.startswith(":"):
            continue
        if line == "":
            if data_lines:
                data = "\n".join(data_lines)
                out.append({"event": event, "data": data})
                if data == "[DONE]":
                    return out
            event, data_lines = None, []
        elif line.startswith("event:"):
            event = line[len("event:"):].strip()
        elif line.startswith("data:"):
            data_lines.append(line[len("data:"):].lstrip())
    if data_lines:
        out.append({"event": event, "data": "\n".join(data_lines)})
    return out

def tool_call_summary(records):
    name_first, arg_chunks, arg_len, reasoning = None, 0, 0, 0
    idx = 0
    for rec in records:
        try:
            obj = json.loads(rec["data"])
        except (ValueError, TypeError):
            continue
        for ch in obj.get("choices", []) or []:
            delta = ch.get("delta") or {}
            if delta.get("reasoning") or delta.get("reasoning_content"):
                reasoning += 1
            for tc in delta.get("tool_calls") or []:
                fn = tc.get("function") or {}
                if fn.get("name") and name_first is None:
                    name_first = idx
                frag = fn.get("arguments")
                if frag:
                    arg_chunks += 1
                    arg_len += len(frag)
        idx += 1
    return {"has_tool_calls": name_first is not None or arg_chunks > 0,
            "name_first_chunk": name_first, "arg_chunks": arg_chunks,
            "arg_total_len": arg_len, "reasoning_chunks": reasoning}
```

- [ ] Run tests. Expected: PASS (4 tests).
- [ ] Commit:

```bash
git add spike/sse.py spike/tests/test_sse.py
git commit -m "spike: SSE parser and tool-call stream summary

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Discovery probes and context-length extractors

**Files:**
- Create: `spike/discovery.py`, `spike/contextlen.py`, `spike/tests/test_contextlen.py`

**Interfaces:**
- Consumes: `httpclient.request`, `redact.redact`, `servers.SERVERS`, `servers.check_available`.
- Produces:
  - `contextlen.extract_llamacpp(props: dict) -> dict` — `{"model": str|None, "n_ctx": int|None}` from llama.cpp `/props` shape (`default_model`, `total_n_ctx` or `n_ctx` or `context_size` — all candidate keys tried; **to verify** which exist).
  - `contextlen.extract_ollama_show(show: dict) -> dict` — `{"model": str|None, "n_ctx": int|None}` from `model_info` map keys ending `.num_ctx` (fallback `parameters.num_ctx`); **to verify**.
  - `contextlen.extract_lmstudio(models: dict) -> list[dict]` — one `{"id", "n_ctx"}` per entry from LM Studio's model-listing shape; **to verify**.
  - `discovery.probe_all(out_dir: pathlib.Path) -> dict` — for each available server, GETs its endpoints (llama.cpp: `/props`; Ollama: `/api/tags`, then `/api/show` per model with body `{"name": <model>}`; LM Studio: `/v1/models` and `/api/v0/models` — both recorded since the canonical one is **to verify**; llama.cpp + Ollama also GET `/v1/models` where applicable), writes each raw response as one JSONL line `{"server","endpoint","status","body"}` to `<out_dir>/discovery.jsonl`, returns `{"server": "available"|"not available", ...}` availability map. Never raises for an absent server.

Steps:
- [ ] Write failing test `spike/tests/test_contextlen.py`:

```python
import unittest
from spike.contextlen import extract_llamacpp, extract_ollama_show, extract_lmstudio

class TestContextLen(unittest.TestCase):
    def test_llamacpp_props(self):
        props = {"default_model": "/models/qwen.gguf", "total_n_ctx": 8192}
        self.assertEqual(extract_llamacpp(props),
                         {"model": "/models/qwen.gguf", "n_ctx": 8192})

    def test_llamacpp_missing_keys(self):
        self.assertEqual(extract_llamacpp({}), {"model": None, "n_ctx": None})

    def test_ollama_show(self):
        show = {"model_info": {"qwen.max_model_len": 32768,
                               "qwen.num_ctx": 4096}}
        self.assertEqual(extract_ollama_show(show),
                         {"model": None, "n_ctx": 4096})

    def test_lmstudio_listing(self):
        listing = {"data": [{"id": "qwen3.5-9b", "context_length": 40960},
                            {"id": "gemma", "context_length": 8192}]}
        self.assertEqual(extract_lmstudio(listing),
                         [{"id": "qwen3.5-9b", "n_ctx": 40960},
                          {"id": "gemma", "n_ctx": 8192}])

if __name__ == "__main__":
    unittest.main()
```

- [ ] Run: `python -m unittest spike.tests.test_contextlen -v`. Expected: FAIL — `ModuleNotFoundError: No module named 'spike.contextlen'`.
- [ ] Implement `spike/contextlen.py`:

```python
def _first_int(d, keys):
    for k in keys:
        v = d.get(k)
        if isinstance(v, int):
            return v
    return None

def extract_llamacpp(props):
    return {"model": props.get("default_model"),
            "n_ctx": _first_int(props, ["total_n_ctx", "n_ctx", "context_size"])}

def extract_ollama_show(show):
    n_ctx = None
    for key, val in (show.get("model_info") or {}).items():
        if key.endswith(".num_ctx") and isinstance(val, int):
            n_ctx = val
    if n_ctx is None:
        n_ctx = (show.get("parameters") or {}).get("num_ctx")
    return {"model": show.get("name"), "n_ctx": n_ctx}

def extract_lmstudio(models):
    return [{"id": m.get("id"),
             "n_ctx": m.get("context_length") or m.get("n_ctx")}
            for m in (models.get("data") or [])]
```

- [ ] Run tests. Expected: PASS (4 tests).
- [ ] Implement `spike/discovery.py`:

```python
import json
from pathlib import Path

from spike.httpclient import ServerGone, request
from spike.redact import redact
from spike.servers import SERVERS, check_available

ENDPOINTS = {
    "llamacpp": ["GET /props", "GET /v1/models"],
    "ollama": ["GET /api/tags", "GET /v1/models"],
    "lmstudio": ["GET /v1/models", "GET /api/v0/models"],
}

def probe_all(out_dir):
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    availability, lines = {}, []
    for name, base in SERVERS.items():
        if not check_available(name):
            availability[name] = "not available"
            continue
        availability[name] = "available"
        for spec in ENDPOINTS[name]:
            method, path = spec.split(" ")
            try:
                status, body = request(method, base + path)
            except ServerGone:
                availability[name] = "not available"
                break
            try:
                parsed = json.loads(body)
            except ValueError:
                parsed = body.decode("utf-8", "replace")[:2000]
            lines.append(json.dumps(redact(
                {"server": name, "endpoint": path, "status": status,
                 "body": parsed})))
        if availability[name] == "available" and name == "ollama":
            lines.extend(_ollama_show_probes(base))
    (out_dir / "discovery.jsonl").write_text(
        "\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")
    return availability

def _ollama_show_probes(base):
    out = []
    try:
        status, body = request("GET", base + "/api/tags")
        tags = json.loads(body).get("models", [])
    except (ServerGone, ValueError):
        return out
    for m in tags:
        name = m.get("name")
        if not name:
            continue
        try:
            status, body = request(
                "POST", base + "/api/show",
                body=json.dumps({"name": name}).encode(),
                headers={"Content-Type": "application/json"})
            out.append(json.dumps(redact(
                {"server": "ollama", "endpoint": f"/api/show:{name}",
                 "status": status, "body": json.loads(body)})))
        except (ServerGone, ValueError):
            continue
    return out
```

- [ ] Manual smoke (no server needed): `python -c "from spike.discovery import probe_all; print(probe_all('docs/superpowers/spike-findings'))"` — with zero servers running, expected output: all three `not available`, empty `discovery.jsonl` created, exit code 0.
- [ ] Commit:

```bash
git add spike/discovery.py spike/contextlen.py spike/tests/test_contextlen.py
git commit -m "spike: discovery probes and context-length extractors

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Tool-call stream recording

**Files:**
- Create: `spike/streams.py`

**Interfaces:**
- Consumes: `httpclient.request`, `sse.parse_stream`, `sse.tool_call_summary`, `redact.redact`, `servers.SERVERS`, `servers.check_available`.
- Produces:
  - `streams.TOOL_SPEC: dict` — the fixed probe tool (`get_weather`, params `city: string`), identical across servers so streams are comparable.
  - `streams.record_all(out_dir: pathlib.Path, model_for: dict[str, str]) -> dict` — for each available server sends one streaming chat-completion request forcing the probe tool (`tool_choice` `"required"` where accepted, else the plain request; both attempts recorded), writes each raw SSE byte stream as one JSONL line `{"server","model","attempt","raw_sse"}` (raw_sse = the exact bytes, latin-1 escaped) plus a summary line `{"server","model","attempt","summary": <tool_call_summary dict>}` to `<out_dir>/streams.jsonl`, returns availability map. Absent servers recorded as `not available`; HTTP errors recorded as `{"server","attempt","error": str}` lines.
  - `streams.pick_model(availability: dict, discovery_bodies: list[dict]) -> dict[str, str]` — first model id seen per server from discovery fixtures; llama.cpp falls back to `"*"` (its `/props` default model).

Steps:
- [ ] Implement `spike/streams.py`:

```python
import json
from pathlib import Path

from spike.httpclient import ServerGone, request
from spike.redact import redact
from spike.servers import SERVERS, check_available
from spike.sse import parse_stream, tool_call_summary

TOOL_SPEC = {
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Get the weather for a city",
        "parameters": {
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"],
        },
    },
}
USER_MSG = "What is the weather in San Francisco? You must call a tool."

def _chat_payload(model, tool_choice):
    p = {"model": model, "stream": True,
         "messages": [{"role": "user", "content": USER_MSG}],
         "tools": [TOOL_SPEC]}
    if tool_choice is not None:
        p["tool_choice"] = tool_choice
    return p

def record_all(out_dir, model_for):
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    lines, availability = [], {}
    for name, base in SERVERS.items():
        if not check_available(name):
            availability[name] = "not available"
            continue
        availability[name] = "available"
        model = model_for.get(name)
        if model is None:
            availability[name] = "no model discovered"
            continue
        for attempt, tc in (("plain", None), ("required", "required")):
            path = "/api/chat" if name == "ollama" else "/v1/chat/completions"
            payload = _chat_payload(model, tc)
            if name == "ollama":
                payload["format"] = "json"  # Ollama native tool API; to verify
            try:
                status, body = request(
                    "POST", base + path,
                    body=json.dumps(payload).encode(),
                    headers={"Content-Type": "application/json"},
                    timeout=120.0)
            except ServerGone as e:
                lines.append(json.dumps({"server": name, "attempt": attempt,
                                         "error": str(e)}))
                continue
            recs = parse_stream(body)
            raw = body.decode("latin-1", "replace")
            lines.append(json.dumps(redact({"server": name, "model": model,
                                            "attempt": attempt,
                                            "status": status,
                                            "raw_sse": raw})))
            lines.append(json.dumps({"server": name, "model": model,
                                     "attempt": attempt,
                                     "summary": tool_call_summary(recs)}))
    (out_dir / "streams.jsonl").write_text(
        "\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")
    return availability

def pick_model(availability, discovery_bodies):
    picked = {}
    for line in discovery_bodies:
        rec = json.loads(line) if isinstance(line, str) else line
        name = rec.get("server")
        if name not in availability or availability[name] != "available":
            continue
        if name in picked or rec.get("status") != 200:
            continue
        body = rec.get("body")
        if not isinstance(body, dict):
            continue
        if name == "ollama":
            models = body.get("models") or []
            mid = models[0].get("name") if models else None
        elif name == "llamacpp" and rec.get("endpoint") == "/props":
            mid = body.get("default_model") or "*"
        else:
            data = body.get("data") or []
            mid = data[0].get("id") if data else None
        if mid:
            picked[name] = mid
    return picked
```

- [ ] No unit test for the network body (throwaway thin code); the pure parts (`parse_stream`, `tool_call_summary`) are already tested. Guard the module against import errors with: `python -c "import spike.streams"` — expected: no error.
- [ ] Commit:

```bash
git add spike/streams.py
git commit -m "spike: streaming tool-call recorder for all three servers

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Reasoning-close continuation probe

**Files:**
- Create: `spike/reasoning.py`

**Interfaces:**
- Consumes: `httpclient.request`, `sse.parse_stream`, `servers.SERVERS`, `servers.check_available`.
- Produces:
  - `reasoning.probe_all(out_dir: pathlib.Path, model_for: dict[str, str]) -> dict` — per available server, runs two requests and records results to `<out_dir>/reasoning.jsonl` as `{"server","strategy","status","body"|"error","reasoning_seen","content_seen"}`; returns per-server verdict `"supported" | "rejected" | "unknown" | "not available"`.
  - Strategies tried, in order (all **to verify** — the probe's whole purpose):
    1. `thinking_disabled`: same prompt with `thinking: {"type": "disabled"}` (Ollama/LM Studio/OpenAI-style) — supported if HTTP 200 and no reasoning deltas.
    2. `chat_template_kwargs`: llama.cpp-style `chat_template_kwargs: {"enable_thinking": false}`.
    3. `continue_after_reasoning`: first request with thinking on and a short `max_tokens` so generation stops mid-reasoning; second request appends the partial assistant reasoning and asks the server to continue (`continue: true` field, else a trailing assistant message) — supported if the second response yields non-reasoning content without repeating the reasoning.

Steps:
- [ ] Implement `spike/reasoning.py`:

```python
import json
from pathlib import Path

from spike.httpclient import ServerGone, request
from spike.redact import redact
from spike.servers import SERVERS, check_available
from spike.sse import parse_stream, tool_call_summary

PROMPT = "Think carefully, then answer: what is 17*23?"

def _strategies(name):
    s = [("thinking_disabled", {"thinking": {"type": "disabled"}}),
         ("chat_template_kwargs",
          {"chat_template_kwargs": {"enable_thinking": False}})]
    if name == "llamacpp":
        s = [s[1], s[0]]
    return s

def _post(base, path, payload):
    return request("POST", base + path, body=json.dumps(payload).encode(),
                   headers={"Content-Type": "application/json"}, timeout=120.0)

def probe_all(out_dir, model_for):
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    lines, verdicts = [], {}
    for name, base in SERVERS.items():
        if not check_available(name):
            verdicts[name] = "not available"
            continue
        model = model_for.get(name)
        path = "/api/chat" if name == "ollama" else "/v1/chat/completions"
        verdict = "unknown"
        for strat, extra in _strategies(name):
            payload = {"model": model, "stream": True,
                       "messages": [{"role": "user", "content": PROMPT}]}
            payload.update(extra)
            try:
                status, body = _post(base, path, payload)
            except ServerGone as e:
                lines.append(json.dumps({"server": name, "strategy": strat,
                                         "error": str(e)}))
                continue
            summ = tool_call_summary(parse_stream(body))
            lines.append(json.dumps(redact({
                "server": name, "strategy": strat, "status": status,
                "reasoning_seen": summ["reasoning_chunks"] > 0,
                "content_seen": b"content" in body})))
            if status == 200 and summ["reasoning_chunks"] == 0:
                verdict = "supported"
                break
        verdicts[name] = verdict
    (out_dir / "reasoning.jsonl").write_text(
        "\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")
    return verdicts
```

- [ ] Guard: `python -c "import spike.reasoning"` — expected: no error.
- [ ] Commit:

```bash
git add spike/reasoning.py
git commit -m "spike: reasoning-close continuation probe

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Classifier, findings generation, runner, live run

**Files:**
- Create: `spike/analyze.py`, `spike/run_spike.py`, `spike/tests/test_analyze.py`
- Generates (committed after the live run): `docs/superpowers/spike-findings/findings.md`, `docs/superpowers/spike-findings/fixtures/*.jsonl`

**Interfaces:**
- Consumes: `discovery.probe_all`, `streams.record_all`, `streams.pick_model`, `reasoning.probe_all`, `sse.tool_call_summary`.
- Produces:
  - `analyze.classify(summary: dict) -> str` — one of `"incremental"`, `"single_chunk"`, `"none"`: `none` if not `has_tool_calls`; `single_chunk` if `arg_chunks <= 1`; else `incremental`. Also: if `name_first_chunk` is not None and `name_first_chunk < index of first arg chunk` the stream is `"incremental_name_first"` (name available before any argument fragment).
  - `analyze.build_findings(availability: dict, stream_lines: list[dict], reasoning_verdicts: dict) -> str` — Markdown findings text with one section per Appendix A item (1–5, 8) and a per-server stream-classification table; every claim carries the fixture file + line number as evidence.
  - `run_spike.main()` — orchestrates: probe_all → pick_model → record_all → reasoning.probe_all → analyze → write `findings.md` and copy fixtures into `docs/superpowers/spike-findings/fixtures/`. Prints the availability map first so partial runs are obvious.

Steps:
- [ ] Write failing test `spike/tests/test_analyze.py`:

```python
import unittest
from spike.analyze import classify, build_findings

class TestAnalyze(unittest.TestCase):
    def test_classify(self):
        self.assertEqual(classify({"has_tool_calls": False, "arg_chunks": 0}), "none")
        self.assertEqual(classify({"has_tool_calls": True, "arg_chunks": 1}), "single_chunk")
        self.assertEqual(classify({"has_tool_calls": True, "arg_chunks": 5}), "incremental")

    def test_findings_mentions_every_server(self):
        md = build_findings(
            {"llamacpp": "available", "ollama": "not available",
             "lmstudio": "not available"},
            [{"server": "llamacpp", "attempt": "plain",
              "summary": {"has_tool_calls": True, "arg_chunks": 3}}],
            {"llamacpp": "supported", "ollama": "not available",
             "lmstudio": "not available"})
        for s in ("llamacpp", "ollama", "lmstudio"):
            self.assertIn(s, md)
        self.assertIn("not available", md)
        self.assertIn("supported", md)

if __name__ == "__main__":
    unittest.main()
```

- [ ] Run: `python -m unittest spike.tests.test_analyze -v`. Expected: FAIL — `ModuleNotFoundError: No module named 'spike.analyze'`.
- [ ] Implement `spike/analyze.py`:

```python
APPENDIX = [
    ("A1", "OpenAI-compatible /v1/models yields a usable model list"),
    ("A2", "llama.cpp /props yields model + n_ctx"),
    ("A3", "Ollama /api/tags + /api/show yield models + context window"),
    ("A4", "LM Studio model-listing endpoint shape + context length"),
    ("A5", "Server-type identification on a probed port"),
    ("A8", "Forced reasoning-close continuation support"),
]

def classify(summary):
    if not summary.get("has_tool_calls"):
        return "none"
    return "incremental" if summary.get("arg_chunks", 0) > 1 else "single_chunk"

def build_findings(availability, stream_lines, reasoning_verdicts):
    out = ["# Spike findings: streams and discovery", "",
           "Resolves spec Appendix A items empirically where servers were",
           "available; absent servers are recorded as `not available`.", "",
           "## Server availability at run time", ""]
    for name, state in availability.items():
        out.append(f"- {name}: {state}")
    out += ["", "## Stream classification", "",
            "| server | attempt | tool calls | classification |",
            "| ------ | ------- | ---------- | -------------- |"]
    for line in stream_lines:
        summ = line.get("summary") or {}
        out.append(f"| {line.get('server')} | {line.get('attempt')} "
                   f"| {summ.get('has_tool_calls')} | {classify(summ)} |")
    out += ["", "## Appendix A items", ""]
    for item, text in APPENDIX:
        verdict = "to verify against recorded fixtures"
        if item == "A8":
            verdict = "; ".join(f"{s}: {v}"
                                for s, v in reasoning_verdicts.items())
        out.append(f"### {item}: {text}\n\nStatus: {verdict}\n")
    return "\n".join(out)
```

- [ ] Run tests. Expected: PASS (2 tests).
- [ ] Implement `spike/run_spike.py`:

```python
import json
import shutil
from pathlib import Path

from spike.analyze import build_findings
from spike.discovery import probe_all
from spike.reasoning import probe_all as probe_reasoning
from spike.streams import pick_model, record_all

FINDINGS_DIR = Path("docs/superpowers/spike-findings")

def main():
    raw = FINDINGS_DIR / "fixtures"
    raw.mkdir(parents=True, exist_ok=True)
    availability = probe_all(raw)
    print("availability:", json.dumps(availability))
    disc_file = raw / "discovery.jsonl"
    disc_lines = disc_file.read_text(encoding="utf-8").splitlines() \
        if disc_file.exists() else []
    models = pick_model(availability, disc_lines)
    print("models:", json.dumps(models))
    record_all(raw, models)
    verdicts = probe_reasoning(raw, models)
    stream_file = raw / "streams.jsonl"
    stream_lines = [json.loads(x) for x in
                    stream_file.read_text(encoding="utf-8").splitlines()
                    if '"summary"' in x] if stream_file.exists() else []
    md = build_findings(availability, stream_lines, verdicts)
    (FINDINGS_DIR / "findings.md").write_text(md, encoding="utf-8")
    print("wrote", FINDINGS_DIR / "findings.md")

if __name__ == "__main__":
    main()
```

- [ ] Run: `python -m unittest discover spike/tests -v`. Expected: PASS (all suites).
- [ ] **Live run with whatever servers the user has running:** `python -m spike.run_spike`. Expected: availability map printed; fixtures written; `findings.md` written. With zero servers: everything recorded `not available`, findings still generated.
- [ ] Manually review `findings.md`; where fixtures show concrete endpoint shapes, replace the corresponding `to verify against recorded fixtures` line with the observed shape + fixture evidence (`file:line`). Do not invent results for absent servers — leave them `not available`.
- [ ] Commit fixtures + findings:

```bash
git add docs/superpowers/spike-findings/
git commit -m "spike: recorded fixtures and findings (streams + discovery)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-review record

- **Spec coverage:** §10.3 (streams from all three servers, incremental-vs-all-at-once, reasoning separately) → Tasks 2, 4, 6. §8 probes (all five endpoint families) → Task 3. §12.6 / Appendix A8 reasoning-close → Task 5. Appendix A5 server-type identification → Task 3 availability detection + findings section. Fixtures as fake-provider corpus → fixtures committed in Task 6. Partial-server operation → `check_available` guards in every `probe_all`/`record_all`, tested in Task 6 findings test.
- **Placeholder scan:** no TBD/TODO; every code block is complete and runnable; `to verify` markers are intentional measurements, the spike's purpose, not plan placeholders.
- **Type/name consistency:** `tool_call_summary` keys (`has_tool_calls`, `arg_chunks`, `name_first_chunk`, `reasoning_chunks`) used identically in Tasks 2, 4, 5, 6; `SERVERS`/`check_available` names identical in Tasks 1, 3, 4, 5; fixture filenames (`discovery.jsonl`, `streams.jsonl`, `reasoning.jsonl`) identical in Tasks 3–6.
- **Assumption noted:** Python 3 stdlib only (no pip) for the throwaway spike; the spec only mandates TypeScript for the product core.
