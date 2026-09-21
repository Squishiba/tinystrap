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
