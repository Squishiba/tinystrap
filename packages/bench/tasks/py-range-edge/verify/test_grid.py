from grid import sequence

def test_sequence_starts_at_one_and_is_inclusive():
    assert sequence(3) == [1, 2, 3]