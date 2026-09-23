import { test } from "node:test";
import assert from "node:assert/strict";
import { area } from "./area.js";
test("returns width times height", () => { assert.equal(area(3, 4), 12); });