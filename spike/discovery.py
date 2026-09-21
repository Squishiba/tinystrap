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
