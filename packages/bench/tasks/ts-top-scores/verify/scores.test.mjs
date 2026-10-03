import { test } from "node:test";
import assert from "node:assert/strict";
import { topScores } from "./scores.js";

test("returns the top n scores highest first", () => {
  assert.deepEqual(topScores([3, 17, 8, 42], 2), [42, 17]);
});

test("leaves the caller's array exactly as it was", () => {
  const board = [3, 17, 8, 42];
  topScores(board, 3);
  assert.deepEqual(board, [3, 17, 8, 42]);
});

test("returns a new array, not the caller's array", () => {
  const board = [5, 9];
  assert.notEqual(topScores(board, 2), board);
});

test("n larger than the board returns the whole ranking and leaves the board alone", () => {
  const board = [5, 9, 7];
  assert.deepEqual(topScores(board, 10), [9, 7, 5]);
  assert.deepEqual(board, [5, 9, 7]);
});

test("n of zero returns an empty array and leaves the board alone", () => {
  const board = [5, 9];
  assert.deepEqual(topScores(board, 0), []);
  assert.deepEqual(board, [5, 9]);
});
