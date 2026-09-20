import type { WeightsReport } from "@sekhemet/models";
import { describe, expect, it } from "vitest";
import { weightsCheck } from "../src/doctor.js";

const report = (over: Partial<WeightsReport>): WeightsReport => ({
  modelsDir: "/models",
  modelsDirExists: true,
  probes: [],
  present: 0,
  missing: [],
  ...over,
});

describe("doctor checks the weights the resolved profile names", () => {
  it("passes only when every named file is there", () => {
    const c = weightsCheck(report({ present: 2, probes: [], missing: [] }));
    expect(c.status).toBe("pass");
    expect(c.detail).toContain("/models");
  });

  it("fails when the models directory holds none of them", () => {
    const c = weightsCheck(
      report({
        missing: ["w"],
        probes: [{ modelId: "w", path: "/models/w.gguf", ok: false, detail: "not found" }],
      }),
    );
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("/models/w.gguf");
  });

  it("warns, rather than failing, when nothing is configured yet", () => {
    const c = weightsCheck(report({ modelsDirExists: false }));
    expect(c.status).toBe("warn");
    expect(c.detail).toMatch(/--models-dir/);
  });
});
