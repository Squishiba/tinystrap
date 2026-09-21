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
