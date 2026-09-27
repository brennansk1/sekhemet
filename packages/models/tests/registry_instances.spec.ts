import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelRegistry, templateChecksum } from "../src/index.js";

/**
 * Live-test F17: two registry instances over one file (a command's and its
 * adapter's) must not write stale copies of an entry over each other's
 * changes. Each reads the file as it is now before it reads or changes.
 */
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sek-reg-inst-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("registry instances over one file (live-test F17)", () => {
  it("keeps a template one instance pinned when a stale one records an arm", () => {
    const path = join(dir, "models.json");
    const command = new ModelRegistry(path);
    const adapter = new ModelRegistry(path);
    command.upsert("m", { family: "qwen" });
    adapter.pinTemplate("m", "{{ messages }}");
    command.recordArmMeasurement("m", "arm_a_flat", 1, 5, 5);
    expect(command.get("m")?.template?.checksum).toBe(templateChecksum("{{ messages }}"));
    const fresh = new ModelRegistry(path);
    expect(fresh.get("m")?.template?.checksum).toBe(templateChecksum("{{ messages }}"));
    expect(fresh.get("m")?.armMeasurements?.arm_a_flat?.passRate).toBe(1);
    expect(fresh.get("m")?.family).toBe("qwen");
  });

  it("keeps the other instance's later change to the same entry", () => {
    const path = join(dir, "models.json");
    const a = new ModelRegistry(path);
    const b = new ModelRegistry(path);
    a.upsert("m", { quant: "IQ3_XXS" });
    b.upsert("m", { family: "qwen" });
    a.upsert("m", { engine: "llama.cpp" });
    expect(new ModelRegistry(path).get("m")).toMatchObject({
      quant: "IQ3_XXS",
      family: "qwen",
      engine: "llama.cpp",
    });
  });
});
