import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { workerScriptCapable } from "../src/execute.js";

describe("run_script only for a script-capable Worker (WL-M2-4)", () => {
  it("reads the registry's mark, and an absent or unreadable registry means no", () => {
    const dir = mkdtempSync(join(tmpdir(), "script-capable-"));
    try {
      const path = join(dir, "models.json");
      writeFileSync(
        path,
        JSON.stringify({ models: [{ id: "able", scriptCapable: true }, { id: "plain" }] }),
      );
      expect(workerScriptCapable("able", path)).toBe(true);
      expect(workerScriptCapable("plain", path)).toBe(false);
      expect(workerScriptCapable("able", join(dir, "missing.json"))).toBe(false);
      writeFileSync(path, "{ not json");
      expect(workerScriptCapable("able", path)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
