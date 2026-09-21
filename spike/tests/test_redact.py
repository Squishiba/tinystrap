import unittest
from spike.redact import redact

class TestRedact(unittest.TestCase):
    def test_redacts_authorization_and_token(self):
        rec = {"headers": {"Authorization": "Bearer sk-abc", "Accept": "application/json"},
               "api_key": "xyz", "model": "qwen"}
        out = redact(rec)
        self.assertEqual(out["headers"]["Authorization"], "[redacted]")
        self.assertEqual(out["headers"]["Accept"], "application/json")
        self.assertEqual(out["api_key"], "[redacted]")
        self.assertEqual(out["model"], "qwen")

    def test_leaves_non_secrets_alone(self):
        rec = {"data": [{"n_ctx": 8192}]}
        self.assertEqual(redact(rec), rec)

if __name__ == "__main__":
    unittest.main()
