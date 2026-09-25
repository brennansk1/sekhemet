import { hostFingerprintHash } from "../../src/calibration.js";
import type { ManagedLlamaServerAdapter } from "../../src/llama_server.js";
import type { ModelRegistry } from "../../src/registry.js";

/**
 * Record that this launch qualified with MTP on and prefix caching on
 * (MD-N8-2): the second condition, beside the speed decision, for MTP to be
 * used. Tests of the speed decision record it so they test that decision.
 */
export function qualifyMtp(reg: ModelRegistry, a: ManagedLlamaServerAdapter): void {
  reg.recordCombinationQualification(
    a.modelId,
    {
      engine: "llama.cpp test",
      modelBuild: "test",
      host: hostFingerprintHash(),
      settings: {
        ...a.launchSettings(),
        speculative: "mtp",
        prefixCaching: true,
        chatTemplate: "test",
        contextVersion: "test",
      },
    },
    { suiteVersion: "q1.1", passRate: 1, status: "qualified", toolCallChecks: true },
  );
}
