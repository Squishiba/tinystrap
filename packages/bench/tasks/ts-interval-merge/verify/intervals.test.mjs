import { test } from "node:test";
import assert from "node:assert/strict";
import { merge } from "./intervals.js";

test("merges overlapping and touching pairs", () => {
  assert.deepEqual(merge([[1, 3], [2, 6], [8, 10], [10, 11]]), [[1, 6], [8, 11]]);
});

test("a nested pair does not shrink the pair that contains it", () => {
  assert.deepEqual(merge([[1, 10], [2, 3], [4, 5]]), [[1, 10]]);
});

test("sorts input that arrives out of order", () => {
  assert.deepEqual(merge([[5, 6], [1, 2], [3, 4]]), [[1, 2], [3, 4], [5, 6]]);
});

test("handles a single pair and an empty list", () => {
  assert.deepEqual(merge([[0, 0]]), [[0, 0]]);
  assert.deepEqual(merge([]), []);
});

test("does not modify the caller's array", () => {
  const input = [[4, 5], [1, 2]];
  merge(input);
  assert.deepEqual(input, [[4, 5], [1, 2]]);
});
