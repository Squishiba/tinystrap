import os
import urllib.error
import urllib.request

SERVERS = {
    "llamacpp": os.environ.get("TS_SPIKE_LLAMACPP", "http://127.0.0.1:8080"),
    "ollama": os.environ.get("TS_SPIKE_OLLAMA", "http://127.0.0.1:11434"),
    "lmstudio": os.environ.get("TS_SPIKE_LMSTUDIO", "http://127.0.0.1:1234"),
}

def check_available(name, timeout=2.0):
    try:
        urllib.request.urlopen(SERVERS[name] + "/", timeout=timeout)
        return True
    except urllib.error.HTTPError:
        # Any HTTP response (even 404) means something is listening.
        return True
    except Exception:
        return False
