import unittest
from spike.analyze import classify, build_findings

class TestAnalyze(unittest.TestCase):
    def test_classify(self):
        self.assertEqual(classify({"has_tool_calls": False, "arg_chunks": 0}), "none")
        self.assertEqual(classify({"has_tool_calls": True, "arg_chunks": 1}), "single_chunk")
        self.assertEqual(classify({"has_tool_calls": True, "arg_chunks": 5}), "incremental")

    def test_findings_mentions_every_server(self):
        md = build_findings(
            {"llamacpp": "available", "ollama": "not available",
             "lmstudio": "not available"},
            [{"server": "llamacpp", "attempt": "plain",
              "summary": {"has_tool_calls": True, "arg_chunks": 3}}],
            {"llamacpp": "supported", "ollama": "not available",
             "lmstudio": "not available"})
        for s in ("llamacpp", "ollama", "lmstudio"):
            self.assertIn(s, md)
        self.assertIn("not available", md)
        self.assertIn("supported", md)

if __name__ == "__main__":
    unittest.main()
