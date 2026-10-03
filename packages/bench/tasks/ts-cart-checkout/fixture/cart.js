import { subtotal } from "./totals.js";

export function checkout(items, discountPct) {
  if (items.length === 0) return { subtotal: 0, discount: 0, shipping: 0, total: 0 };
  const sub = subtotal(items);
  const shipping = sub >= 50 ? 0 : 8;
  const discount = ((sub + shipping) * discountPct) / 100;
  return { subtotal: sub, discount, shipping, total: sub + shipping - discount };
}
