import { describe, expect, it } from "vitest";
import { resolveWorkerModelId } from "../src/index.js";

/**
 * SEC-37b keys the injection pass on the model the Worker actually is. A
 * managed name (`cyber-tiel`) is served under its own model id, which is the
 * key the model registry records its quantisation under (B1 Tier 3 run).
 */
describe("resolveWorkerModelId", () => {
  it("maps a managed name to the model it serves", () => {
    expect(resolveWorkerModelId("cyber-tiel")).toBe("cyber-tiel-coder-35b-a3b-mtp-iq3xxs");
    expect(resolveWorkerModelId("dirk")).toBe(resolveWorkerModelId("qwen3.8-27b"));
  });

  it("keeps an Ollama tag, without its prefix", () => {
    expect(resolveWorkerModelId("ollama/qwen3:8b")).toBe("qwen3:8b");
    expect(resolveWorkerModelId("qwen3:8b")).toBe("qwen3:8b");
  });
});
