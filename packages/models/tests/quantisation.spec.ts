import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GGUFValueType, serializeGgufMetadata } from "@huggingface/gguf";
import { afterEach, describe, expect, it } from "vitest";
import { readQuantisation } from "../src/quantisation.js";

/**
 * MD-M4-5: the quantisation in the reproducibility record, read from the
 * model file itself (SEC-37b keys the injection pass on it; the B1 Tier 3
 * run found nothing recorded it).
 */
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function ggufFile(name: string, fileType?: number): string {
  const d = mkdtempSync(join(tmpdir(), "sek-quant-"));
  dirs.push(d);
  const header = serializeGgufMetadata({
    version: { value: 3, type: GGUFValueType.UINT32 },
    tensor_count: { value: 0n, type: GGUFValueType.UINT64 },
    kv_count: { value: fileType === undefined ? 1n : 2n, type: GGUFValueType.UINT64 },
    "general.architecture": { value: "qwen3moe", type: GGUFValueType.STRING },
    ...(fileType === undefined
      ? {}
      : { "general.file_type": { value: fileType, type: GGUFValueType.UINT32 } }),
  } as Parameters<typeof serializeGgufMetadata>[0]);
  const file = join(d, name);
  writeFileSync(file, header);
  return file;
}

describe("readQuantisation", () => {
  it("reads the file type the GGUF header records", async () => {
    // 23 is IQ3_XXS in llama.cpp's file-type enum.
    expect(await readQuantisation(ggufFile("model.gguf", 23))).toBe("IQ3_XXS");
    expect(await readQuantisation(ggufFile("model.gguf", 15))).toBe("Q4_K_M");
  });

  it("falls back to the file name when the header has no file type", async () => {
    // The label as llama.cpp's naming gives it, recipe prefix included.
    expect(await readQuantisation(ggufFile("Cyber-Tiel-UD-IQ3_XXS.gguf"))).toBe("UD-IQ3_XXS");
    expect(await readQuantisation(ggufFile("model-Q4_K_M.gguf"))).toBe("Q4_K_M");
  });

  it("returns undefined when neither says", async () => {
    expect(await readQuantisation(ggufFile("model.gguf"))).toBeUndefined();
    expect(await readQuantisation("/nonexistent/model.gguf")).toBeUndefined();
  });
});
