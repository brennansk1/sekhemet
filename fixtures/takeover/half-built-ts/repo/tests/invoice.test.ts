import assert from "node:assert/strict";
import { test } from "node:test";
import { invoiceTotal } from "../src/invoice.ts";

test("creates an invoice with a total", () => {
  assert.equal(invoiceTotal([{ price: 2, qty: 3 }]), 6);
});
