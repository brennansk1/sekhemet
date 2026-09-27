import assert from "node:assert/strict";
import { test } from "node:test";
import { roundTotal } from "../src/total.ts";

test("rounds totals to cents", () => {
  assert.equal(roundTotal(1.005), 1.01);
});
