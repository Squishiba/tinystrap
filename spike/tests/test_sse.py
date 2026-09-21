import unittest
from spike.sse import parse_stream, tool_call_summary

RAW = (b'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"get_weather","arguments":""}}]}}]}\n\n'
       b'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"ci"}}]}}]}\n\n'
       b'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ty\\":\\"SF\\"}"}}]}}]}\n\n'
       b'data: [DONE]\n\n')

class TestSse(unittest.TestCase):
    def test_parse_stream(self):
        recs = parse_stream(RAW)
        self.assertEqual(len(recs), 4)
        self.assertEqual(recs[-1]["data"], "[DONE]")

    def test_summary_incremental(self):
        recs = parse_stream(RAW)
        s = tool_call_summary(recs)
        self.assertTrue(s["has_tool_calls"])
        self.assertEqual(s["name_first_chunk"], 0)
        self.assertEqual(s["arg_chunks"], 3)
        self.assertEqual(s["arg_total_len"], len('{"city":"SF"}'))
        self.assertEqual(s["reasoning_chunks"], 0)

    def test_summary_single_chunk(self):
        one = ('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":'
               '{"name":"f","arguments":"{\\"a\\":1}"}}]}}]}\n\ndata: [DONE]\n\n').encode()
        s = tool_call_summary(parse_stream(one))
        self.assertEqual(s["arg_chunks"], 1)

    def test_summary_reasoning(self):
        r = ('data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n'
             'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n').encode()
        s = tool_call_summary(parse_stream(r))
        self.assertFalse(s["has_tool_calls"])
        self.assertEqual(s["reasoning_chunks"], 1)

if __name__ == "__main__":
    unittest.main()
