import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupe } from "./dedupe.js";
test("keeps the first occurrence of each element, in order, including index 0", () => {
  assert.deepEqual(dedupe([5, 1, 2, 2, 3]), [5, 1, 2, 3]);
});