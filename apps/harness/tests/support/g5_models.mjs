// Set up the model registry and machine profile a person's earlier work left
// on this host, for the models entry-point tests (C2d, group G5): computed by
// the built binary's own modules in a plain Node process, never inside the
// test runner (whose module transform rewrites the prompt modules a role's
// context version hashes). The registry and profile are the ones
// SEKHEMET_MODEL_REGISTRY and SEKHEMET_MACHINE_PROFILE name.
//
//   node g5_models.mjs '<json steps>'
//
// A step is one of:
//   {"qualify": "<model>", "role": "worker", "status": "qualified"|"failed", "family": "qwen"}
//     ("as": "worker" resolves the model as that role's adapter, as `qualify --role`
//     and `models assign` do: they describe every model as the Worker, wave2.ts)
//   {"profile": "<model>", "prefill": 20, "decode": 4}   (measured on this host;
//     "usableGb" and "tier" give the calibrated usable memory and tier, default 16 and M)
import {
  ModelRegistry,
  ModelRoster,
  QUALIFICATION_SUITE_VERSION,
  hardwareFingerprint,
  hostFingerprintHash,
  saveMachineProfile,
} from "@sekhemet/models";
import { qualificationCombination } from "../../dist/qualify.js";

const steps = JSON.parse(process.argv[2] ?? "[]");
const registry = new ModelRegistry(process.env.SEKHEMET_MODEL_REGISTRY);
for (const step of steps) {
  if (step.qualify) {
    const role = step.role ?? "worker";
    const adapter = new ModelRoster({ registry }).resolve(step.qualify, step.as ?? role);
    if (step.family) registry.upsert(adapter.modelId, { family: step.family });
    const failed = step.status === "failed";
    registry.recordCombinationQualification(
      adapter.modelId,
      qualificationCombination(adapter, { registry, role }),
      {
        suiteVersion: QUALIFICATION_SUITE_VERSION,
        passRate: failed ? 0.4 : 1,
        status: failed ? "failed" : "qualified",
        toolCallChecks: !failed,
        ...(failed ? { byCategory: { tool_calls: 0.4 }, reason: "pass rate 40%" } : {}),
      },
    );
  }
  if (step.profile) {
    saveMachineProfile(
      {
        version: 1,
        date: "2026-09-25T00:00:00Z",
        fingerprint: hardwareFingerprint(),
        fingerprintHash: hostFingerprintHash(),
        usableBytes: (step.usableGb ?? 16) * 1024 ** 3,
        tier: step.tier ?? "M",
        models: {
          measured: {
            modelId: step.profile,
            label: "measured",
            buckets: {},
            speed: { prefillTokensPerSecond: step.prefill, decodeTokensPerSecond: step.decode },
            throughputClass: "below_floor",
          },
        },
      },
      process.env.SEKHEMET_MACHINE_PROFILE,
    );
  }
}
