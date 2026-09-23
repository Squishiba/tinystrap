import { test } from "node:test";
import assert from "node:assert/strict";
import { reverse } from "./reverse.js";
test("reverses the string", () => { assert.equal(reverse("hello"), "olleh"); });