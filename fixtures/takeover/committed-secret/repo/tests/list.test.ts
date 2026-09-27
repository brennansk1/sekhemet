import assert from "node:assert/strict";
import { test } from "node:test";
import { listInvoices } from "../src/list.ts";

test("lists invoices by date", () => {
  assert.deepEqual(listInvoices(["2026-02-01", "2026-01-01"]), ["2026-01-01", "2026-02-01"]);
});
