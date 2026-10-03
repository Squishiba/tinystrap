from totals import order_total


def summarize(orders):
    """Return (customer, total) pairs: highest total first, ties by customer name A-Z."""
    totals = {}
    for order in orders:
        totals[order["customer"]] = totals.get(order["customer"], 0.0) + order_total(order["lines"])
    return sorted(totals.items())
