import assert from "node:assert/strict";
import { test } from "node:test";
import { sumLines } from "../src/sum.ts";

test("sums invoice lines", () => {
  assert.equal(sumLines([1, 2, 3]), 6);
});
