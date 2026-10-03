import { test } from "node:test";
import assert from "node:assert/strict";
import { subtotal } from "./totals.js";
import { checkout } from "./cart.js";

test("subtotal charges each line's price times its quantity", () => {
  assert.equal(subtotal([{ price: 10, qty: 2 }, { price: 5, qty: 3 }]), 35);
});

test("checkout applies the discount to the goods and then checks the shipping threshold", () => {
  const items = [{ price: 10, qty: 2 }, { price: 5, qty: 3 }];
  assert.deepEqual(checkout(items, 10), { subtotal: 35, discount: 3.5, shipping: 8, total: 39.5 });
});

test("a cart at or over the threshold after the discount ships free", () => {
  assert.deepEqual(checkout([{ price: 30, qty: 2 }], 0), {
    subtotal: 60, discount: 0, shipping: 0, total: 60,
  });
});

test("a discount can push a cart below the free-shipping threshold", () => {
  assert.deepEqual(checkout([{ price: 52, qty: 1 }], 12.5), {
    subtotal: 52, discount: 6.5, shipping: 8, total: 53.5,
  });
});

test("an empty cart is all zeros", () => {
  assert.deepEqual(checkout([], 50), { subtotal: 0, discount: 0, shipping: 0, total: 0 });
});
