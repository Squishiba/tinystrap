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
