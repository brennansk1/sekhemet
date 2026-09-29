import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedLlamaServerAdapter, ModelRegistry, samplingSettingsOf } from "@sekhemet/models";
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

const run = async (path: string, id?: string, sampling?: string) => {
  const lines: string[] = [];
  const code = await modelsAdd(path, {
    registry,
    ...(id ? { id } : {}),
    ...(sampling !== undefined ? { sampling } : {}),
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

  it("F25: says, and records, that a gpt-oss model cannot turn its reasoning off", async () => {
    const file = writeGguf(join(dir, "gpt-oss-20b-Q4_K_M.gguf"), {
      architecture: "gpt-oss",
      name: "gpt-oss-20b",
    });
    const { code, lines } = await run(file, "gpt-oss-20b");
    expect(code).toBe(0);
    expect(registry.get("gpt-oss-20b")?.reasoning).toMatchObject({
      cannotDisable: true,
      floor: "low",
    });
    expect(lines.join("\n")).toMatch(
      /gpt-oss-20b cannot turn its reasoning off \(architecture gpt-oss\): a request for none thinks at low/,
    );
    const qwen = writeGguf(join(dir, "q.gguf"), { architecture: "qwen3moe", name: "Q" });
    expect((await run(qwen, "q")).lines.join("\n")).not.toMatch(/reasoning off/);
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

// Live-test F16: a generic model ran at its family's default sampling (Qwen's
// 0.7 / 0.8 / 20), not its model card's; `--sampling` records the card's
// values, and the output always says which sampling the model will run at.
describe("sekhemet models add --sampling (live-test F16)", () => {
  const qwen = () =>
    writeGguf(join(dir, "Tiel-Coder.gguf"), { architecture: "qwen3moe", name: "Tiel Coder" });

  it("records the model card's sampling, runs at it, and says so", async () => {
    const { code, lines } = await run(
      qwen(),
      "tiel-coder",
      "temperature=0.6,top_p=0.95,top_k=20,min_p=0",
    );
    expect(code).toBe(0);
    expect(registry.get("tiel-coder")?.sampling).toEqual({
      temperature: 0.6,
      topP: 0.95,
      topK: 20,
      minP: 0,
    });
    const a = describeModel("tiel-coder", "worker", { registry });
    expect(samplingSettingsOf(a)).toEqual({ temperature: 0.6, topP: 0.95, topK: 20, minP: 0 });
    expect(lines.join("\n")).toMatch(
      /runs at temperature 0\.6, top_p 0\.95, top_k 20, min_p 0 \(the values given with --sampling\)/,
    );
  });

  it("without --sampling, states the family defaults it will run at and how to record the card's", async () => {
    const { code, lines } = await run(qwen(), "tiel-coder");
    expect(code).toBe(0);
    expect(registry.get("tiel-coder")?.sampling).toBeUndefined();
    expect(lines.join("\n")).toMatch(
      /runs at temperature 0\.7, top_p 0\.8, top_k 20, min_p 0 \(the qwen family's defaults, not this model's card\).*--sampling temperature=,top_p=,top_k=,min_p=/s,
    );
  });

  it("refuses an unknown key or a value out of range, and records nothing", async () => {
    for (const bad of ["temp=0.6", "temperature=hot", "top_p=1.5", "top_k=2.5", "min_p=-1", ""]) {
      const { code, lines } = await run(qwen(), "tiel-coder", bad);
      expect(code, bad).toBe(1);
      expect(lines.join("\n")).toMatch(/--sampling/);
      expect(registry.get("tiel-coder")).toBeUndefined();
    }
  });
});
