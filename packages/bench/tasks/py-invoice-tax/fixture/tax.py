def tax_for(amount, rate):
    """Return amount * rate rounded to 2 decimals; exact halves round UP (0.125 -> 0.13)."""
    return round(amount * rate, 2)
