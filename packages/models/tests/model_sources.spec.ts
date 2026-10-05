import { describe, expect, it } from "vitest";
import { MODEL_SOURCES, tableSource } from "../src/hf_lookup.js";
import { MANAGED_MODEL_FILES, createCyberTielWorker } from "../src/llama_server.js";

// MD-N12-6, models rule 4: the official source of each managed default,
// filled only from what is verifiable on this host — the model card's
// `hf download` line and the file's SHA-256 computed from the local copy —
// so a download can be confirmed (source, size, hash) before any request
// (dashboard DB-N6-16). A default whose source cannot be verified is absent;
// since C3 the table is derived from the shipped set (shipped_models.spec.ts).

describe("the model sources table (MD-N12-6)", () => {
  it("names the Worker's official repository, file, size and SHA-256", () => {
    const id = createCyberTielWorker().modelId;
    const row = MODEL_SOURCES[id];
    expect(row).toEqual({
      repo: "peculiar-ragdoll/Cyber-Tiel-Coder-35B-A3B-GGUF-MTP",
      file: "Cyber-Tiel-Coder-35B-A3B-MTP-UD-IQ3_XXS.gguf",
      sha256: "d60adb32312166b49ceffbd10aed297aee69626b45ec4e720700450ee048bd0e",
      sizeBytes: 13_600_579_904,
    });
    // The same file the managed Worker loads.
    expect(MANAGED_MODEL_FILES.worker.endsWith(`/${row?.file}`)).toBe(true);
  });

  it("builds a download source from the table with no request: URL, host, hash and size", () => {
    const s = tableSource(createCyberTielWorker().modelId);
    expect(s).toEqual({
      url: "https://huggingface.co/peculiar-ragdoll/Cyber-Tiel-Coder-35B-A3B-GGUF-MTP/resolve/main/Cyber-Tiel-Coder-35B-A3B-MTP-UD-IQ3_XXS.gguf",
      host: "huggingface.co",
      sha256: "d60adb32312166b49ceffbd10aed297aee69626b45ec4e720700450ee048bd0e",
      sizeBytes: 13_600_579_904,
      repo: "peculiar-ragdoll/Cyber-Tiel-Coder-35B-A3B-GGUF-MTP",
      file: "Cyber-Tiel-Coder-35B-A3B-MTP-UD-IQ3_XXS.gguf",
    });
    expect(tableSource("no-such-model")).toBeUndefined();
  });

  it("lists no file it could not verify: the managed Planner's file name, which its repository now publishes as a different file, is not a source (rule 4)", () => {
    const files = Object.values(MODEL_SOURCES).map((r) => r.file);
    expect(files).not.toContain(MANAGED_MODEL_FILES.planner.split("/").pop());
    // The Planning model's source is the file the reference host qualified, under its published name.
    expect(files).toContain("Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf");
    // The Researcher's is the exact file the managed profile loads.
    expect(files).toContain(MANAGED_MODEL_FILES.researcher.split("/").pop());
    for (const row of Object.values(MODEL_SOURCES)) {
      expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(row.sizeBytes).toBeGreaterThan(1e9);
    }
  });
});
