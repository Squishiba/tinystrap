from invoice import invoice_total
from tax import tax_for


def test_tax_rounds_exact_halves_up():
    assert tax_for(0.5, 0.25) == 0.13  # 0.125 goes up, not to round()'s 0.12


def test_tax_on_amounts_that_are_already_exact():
    assert tax_for(2.0, 0.375) == 0.75
    assert tax_for(1.0, 0.1) == 0.1


def test_tax_is_charged_once_on_the_whole_subtotal():
    lines = [{"price": 0.5, "qty": 1}, {"price": 0.5, "qty": 1}]
    assert invoice_total(lines, 0.25) == 1.25


def test_tax_on_a_multi_line_cart_that_lands_on_a_half_cent():
    lines = [{"price": 1.25, "qty": 1}, {"price": 1.25, "qty": 1}]
    assert invoice_total(lines, 0.05) == 2.63  # subtotal 2.5, tax 0.125 -> 0.13
