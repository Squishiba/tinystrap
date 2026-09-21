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
