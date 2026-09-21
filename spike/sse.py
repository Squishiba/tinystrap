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
                if frag is not None:
                    arg_chunks += 1
                    arg_len += len(frag)
        idx += 1
    return {"has_tool_calls": name_first is not None or arg_chunks > 0,
            "name_first_chunk": name_first, "arg_chunks": arg_chunks,
            "arg_total_len": arg_len, "reasoning_chunks": reasoning}
