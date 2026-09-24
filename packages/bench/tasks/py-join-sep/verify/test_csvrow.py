from csvrow import row

def test_row_joins_with_comma_space():
    assert row(["a", "b", "c"]) == "a, b, c"