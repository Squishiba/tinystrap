import unittest
from spike.contextlen import extract_llamacpp, extract_ollama_show, extract_lmstudio

class TestContextLen(unittest.TestCase):
    def test_llamacpp_props(self):
        props = {"default_model": "/models/qwen.gguf", "total_n_ctx": 8192}
        self.assertEqual(extract_llamacpp(props),
                         {"model": "/models/qwen.gguf", "n_ctx": 8192})

    def test_llamacpp_missing_keys(self):
        self.assertEqual(extract_llamacpp({}), {"model": None, "n_ctx": None})

    def test_ollama_show(self):
        show = {"model_info": {"qwen.max_model_len": 32768,
                               "qwen.num_ctx": 4096}}
        self.assertEqual(extract_ollama_show(show),
                         {"model": None, "n_ctx": 4096})

    def test_lmstudio_listing(self):
        listing = {"data": [{"id": "qwen3.5-9b", "context_length": 40960},
                            {"id": "gemma", "context_length": 8192}]}
        self.assertEqual(extract_lmstudio(listing),
                         [{"id": "qwen3.5-9b", "n_ctx": 40960},
                          {"id": "gemma", "n_ctx": 8192}])

if __name__ == "__main__":
    unittest.main()
