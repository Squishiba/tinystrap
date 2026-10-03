from report import summarize
from totals import order_total


def test_order_total_skips_cancelled_lines():
    lines = [
        {"price": 10.0, "qty": 2, "cancelled": False},
        {"price": 5.0, "qty": 3, "cancelled": True},
    ]
    assert order_total(lines) == 20.0


def test_summarize_ranks_by_total_descending():
    # Names are in the same order as the input but NOT in the order of their totals.
    orders = [
        {"customer": "amy", "lines": [{"price": 5.0, "qty": 4, "cancelled": False}]},
        {"customer": "bo", "lines": [{"price": 10.0, "qty": 3, "cancelled": False}]},
        {
            "customer": "cy",
            "lines": [
                {"price": 4.0, "qty": 1, "cancelled": False},
                {"price": 99.0, "qty": 1, "cancelled": True},
            ],
        },
    ]
    assert summarize(orders) == [("bo", 30.0), ("amy", 20.0), ("cy", 4.0)]


def test_summarize_breaks_ties_by_name():
    orders = [
        {"customer": "zoe", "lines": [{"price": 5.0, "qty": 2, "cancelled": False}]},
        {"customer": "amy", "lines": [{"price": 10.0, "qty": 1, "cancelled": False}]},
    ]
    assert summarize(orders) == [("amy", 10.0), ("zoe", 10.0)]


def test_summarize_adds_up_repeated_customers():
    orders = [
        {"customer": "amy", "lines": [{"price": 1.0, "qty": 1, "cancelled": False}]},
        {"customer": "amy", "lines": [{"price": 2.0, "qty": 2, "cancelled": True}]},
    ]
    assert summarize(orders) == [("amy", 1.0)]
