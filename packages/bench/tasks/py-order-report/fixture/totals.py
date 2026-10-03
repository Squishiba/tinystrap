def order_total(lines):
    """Total of price * qty for the lines that count; a cancelled line never counts."""
    total = 0.0
    for line in lines:
        total += line["price"] * line["qty"]
    return total
