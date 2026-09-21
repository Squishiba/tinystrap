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
