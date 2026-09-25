import type { GateRunner } from "@sekhemet/gates";
import { describe, expect, it } from "vitest";
import { withArchitectureGate } from "../src/architecture_gate.js";
import { withLicenseGate } from "../src/license_gate.js";
import { withReachabilityGate } from "../src/reachability_gate.js";
import { withRegressionGate } from "../src/regression_gate.js";
import { withTrailerGate } from "../src/trailer_gate.js";

// GT-M6-5: the project gates' ids come from the wrappers themselves, so the
// Worker's `note` enum can never drift from the gates that run.

const inner: GateRunner = {
  runGates: async () => ({ passed: true, failures: [], durationMs: 1, rungResults: [] }),
};

describe("each project gate names itself", () => {
  it("lists every wrapper's gate id, innermost first", () => {
    const runner = withArchitectureGate(
      withRegressionGate(withReachabilityGate(withTrailerGate(withLicenseGate(inner, "/r")))),
    );
    expect(runner.gateIds).toEqual([
      "licenses",
      "trailers",
      "reachability",
      "regression",
      "architecture",
    ]);
  });
});
