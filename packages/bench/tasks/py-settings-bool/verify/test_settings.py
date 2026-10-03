import pytest

from settings import to_bool


@pytest.mark.parametrize("word", ["true", "TRUE", "1", "Yes", "on", "On"])
def test_true_words(word):
    assert to_bool(word) is True


@pytest.mark.parametrize("word", ["false", "FALSE", "0", "no", "Off", ""])
def test_false_words(word):
    assert to_bool(word) is False


@pytest.mark.parametrize("word", ["maybe", "2", "tru", "falsey"])
def test_unknown_words_raise(word):
    with pytest.raises(ValueError):
        to_bool(word)
