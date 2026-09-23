import { test } from "node:test";
import assert from "node:assert/strict";
import { isAdult } from "./isAdult.js";
test("18 counts as adult, 17 does not", () => {
  assert.equal(isAdult(18), true);
  assert.equal(isAdult(17), false);
});