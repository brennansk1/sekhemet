import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedLlamaServerAdapter, ModelRegistry } from "@sekhemet/models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeGguf } from "../../../packages/models/tests/support/gguf_fixture.js";
import { describeModel, weightsKey } from "../src/model_access.js";
import { modelsAdd } from "../src/models_cmd.js";

// Live-test F1/F7, MD-N12-9, MD-N12-10: `sekhemet models add <path> [--id <id>]`
// registers a person's GGUF, which then runs as a role under a managed
// llama-server and is qualified under its own id.

let dir: string;
let registry: ModelRegistry;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sek-add-"));
  registry = new ModelRegistry(join(dir, "models.json"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const run = async (path: string, id?: string) => {
  const lines: string[] = [];
  const code = await modelsAdd(path, {
    registry,
    ...(id ? { id } : {}),
    print: (l) => lines.push(l),
  });
  return { code, lines };
};

describe("sekhemet models add (MD-N12-9)", () => {
  it("records the file's weights, hash, size and header, and the id then runs as a managed Worker", async () => {
    const file = writeGguf(join(dir, "Tiel-Coder-35B-A3B-MTP-UD-IQ3_XXS.gguf"), {
      architecture: "qwen3moe",
      name: "Tiel Coder 35B A3B MTP",
      contextLength: 262144,
      padBytes: 4096,
    });
    const { code, lines } = await run(file, "tiel-coder");
    expect(code).toBe(0);
    expect(lines.join("\n")).toMatch(/tiel-coder/);
    expect(lines.join("\n")).toMatch(/sekhemet qualify --models tiel-coder/);
    const e = registry.get("tiel-coder");
    expect(e?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(e?.sizeBytes).toBeGreaterThan(4096);
    expect(e?.header?.contextLength).toBe(262144);
    const a = describeModel("tiel-coder", "worker", { registry });
    expect(a).toBeInstanceOf(ManagedLlamaServerAdapter);
    expect(a.modelId).toBe("tiel-coder");
    expect((a as ManagedLlamaServerAdapter).launchProfile.modelPath).toBe(file);
    // Smart Swap and qualification key on the same id.
    expect(weightsKey("tiel-coder")).toBe("tiel-coder");
  });

  it("a managed name as the id makes the file that managed model's weights (MD-N14-41a)", async () => {
    const file = writeGguf(join(dir, "Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf"), {
      architecture: "qwen3",
      name: "Qwen3.8 27B",
    });
    const { code } = await run(file, "dirk");
    expect(code).toBe(0);
    expect(registry.preferredWeights("qwen3.8-27b")).toBe(file);
    const a = describeModel("dirk", "planner", { registry }) as ManagedLlamaServerAdapter;
    expect(a.launchProfile.modelPath).toBe(file);
  });

  it("names the refusal and exits 1 for a file that is not a GGUF", async () => {
    const file = join(dir, "readme.gguf");
    writeFileSync(file, "hello");
    const { code, lines } = await run(file, "x");
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/GGUF/);
    expect(registry.get("x")).toBeUndefined();
  });

  it("names the refusal and exits 1 when the hash differs from the id's recorded weights", async () => {
    const file = writeGguf(join(dir, "p.gguf"), { architecture: "qwen3", name: "P" });
    registry.upsert("qwen3.8-27b", { sha256: "c".repeat(64) });
    const { code, lines } = await run(file, "qwen3.8-27b");
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/differs/);
    expect(registry.get("qwen3.8-27b")?.copies).toBeUndefined();
  });
});
