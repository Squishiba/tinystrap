from tax import tax_for


def invoice_total(lines, rate):
    """Subtotal plus the tax charged once on that whole subtotal."""
    total = 0.0
    for line in lines:
        amount = line["price"] * line["qty"]
        total += round(amount, 2) + tax_for(amount, rate)
    return total
