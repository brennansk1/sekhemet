import assert from "node:assert/strict";
import { test } from "node:test";
import { applyDiscount } from "../src/discount.ts";

test("applies a discount code", () => {
  assert.equal(applyDiscount(100, "TEN"), 90);
});
