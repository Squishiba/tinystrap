from basket import add

def test_add_does_not_leak_between_calls():
    first = add("apple")
    second = add("banana")
    assert second == ["banana"]