// Record the scripted model as qualified for the given roles, computed by the
// built binary's own modules in a plain Node process (the C2d entry-point
// tests). A role's prompt version hashes its copy modules' text, functions
// included, so it is computed here, never inside the test runner, whose
// module transform rewrites that text.
//
//   node g2_qualify.mjs <model> '<[{"role":"worker","contextVersion":"…"}]>'
//
// The registry is the one SEKHEMET_MODEL_REGISTRY names, as the binary reads it.
import { ModelRegistry, ModelRoster, QUALIFICATION_SUITE_VERSION } from "@sekhemet/models";
import { qualificationCombination } from "../../dist/qualify.js";

const [model, rolesJson] = process.argv.slice(2);
const registry = new ModelRegistry(process.env.SEKHEMET_MODEL_REGISTRY);
for (const q of JSON.parse(rolesJson ?? "[{}]")) {
  const role = q.role ?? "worker";
  const adapter = new ModelRoster({ registry }).resolve(model, role);
  const version = q.contextVersion;
  registry.recordCombinationQualification(
    adapter.modelId,
    qualificationCombination(adapter, {
      registry,
      role,
      ...(version ? { contextVersion: () => version } : {}),
    }),
    {
      suiteVersion: QUALIFICATION_SUITE_VERSION,
      passRate: 1,
      status: "qualified",
      toolCallChecks: true,
    },
  );
}
