import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry, type ModelRole, type QualificationCombination } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import { modelVerificationCheck } from "../src/doctor.js";

// CX-N6-1, CX-N6-4 (live-tests F23, F24): doctor names the models this build
// owes a re-verification, per role, and reads nothing another build owes.

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const combo = (contextVersion: string, role?: ModelRole): QualificationCombination => ({
  engine: "llama.cpp b1",
  modelBuild: "digest",
  host: "h1",
  settings: {
    contextTokens: 16_384,
    kvType: "q8_0",
    speculative: "off",
    prefixCaching: true,
    parallelSlots: 1,
    chatTemplate: "t",
    contextVersion,
    ...(role && role !== "worker" ? { role } : {}),
  },
});
const pass = { suiteVersion: "q1.2", passRate: 0.95, status: "qualified" as const };
const versions = (worker: string, reviewer = "r1") => ({
  worker,
  planner: "p1",
  reviewer,
  researcher: "s1",
});

function registry(): { reg: ModelRegistry; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "sek-doctor-rq-"));
  dirs.push(dir);
  const path = join(dir, "models.json");
  return { reg: new ModelRegistry(path), path };
}

describe("doctor: models this build owes a re-verification", () => {
  it("passes when every verified model is verified under this build's prompts", () => {
    const { reg } = registry();
    expect(modelVerificationCheck(reg, versions("w1"))).toMatchObject({ status: "pass" });
    reg.recordCombinationQualification("nail-mtp", combo("w1"), pass);
    expect(modelVerificationCheck(reg, versions("w1"))).toMatchObject({
      name: "Model verification",
      status: "pass",
    });
  });

  it("names each model and role whose prompts changed since it was verified, and the command, without writing", () => {
    const { reg, path } = registry();
    reg.recordCombinationQualification("nail-mtp", combo("w1"), pass);
    reg.recordCombinationQualification("critic", combo("r1", "reviewer"), pass);
    const before = readFileSync(path, "utf8");
    const check = modelVerificationCheck(reg, versions("w2", "r2"));
    expect(check.status).toBe("warn");
    expect(check.detail).toContain(
      "Coding model nail-mtp (context version changed (w1 -> w2)): sekhemet qualify --models nail-mtp",
    );
    expect(check.detail).toContain(
      "Review model critic (context version changed (r1 -> r2)): sekhemet qualify --models critic --role reviewer",
    );
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("F23: another build's newer prompts owe nothing on this build", () => {
    const { reg } = registry();
    reg.recordCombinationQualification("nail-mtp", combo("w1"), pass);
    // A newer build ran and scheduled its own re-verification.
    new ModelRegistry(reg.path).observeContextVersion("w2");
    expect(modelVerificationCheck(reg, versions("w1"))).toMatchObject({ status: "pass" });
  });
});
