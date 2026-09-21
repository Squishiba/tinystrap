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
