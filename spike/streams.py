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
