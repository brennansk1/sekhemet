import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { EventStore } from "../src/store.js";

it("refuses a fractional limit with the RangeError", () => {
  const dir = mkdtempSync(join(tmpdir(), "vanguard-witness-"));
  const store = new EventStore(join(dir, "events.db"));
  try {
    expect(() => store.list({ limit: 1.5 })).toThrow(RangeError);
    expect(() => store.list({ limit: 1.5 })).toThrow("limit must be >= 1");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
