import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockInferenceAdapter, readBakeOffRecords } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import { childSettings, recordBakeOff } from "../src/wave2.js";

// MD-N4-6: a bake-off record carries the settings the child's evidence
// recorded, not settings rebuilt afterwards in the parent.

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe("MD-N4-6: the bake-off reports the child's recorded settings", () => {
  it("records the evidence settings over the parent's rebuilt ones, and says where they came from", async () => {
    const repo = mkdtempSync(join(tmpdir(), "sek-bake-"));
    dirs.push(repo);
    const evidence = {
      modelId: "w",
      quant: "IQ3_XXS",
      engine: "llama.cpp",
      toolArm: "arm_b_json",
      toolArmMeasured: true,
      contextTokens: 12_288,
      kvType: "q8_0",
      mtp: false,
      harnessCommit: "abc123",
    };
    const result = { candidateSettings: evidence } as never;
    expect(childSettings(result)).toEqual(evidence);
    expect(childSettings({} as never)).toBeUndefined();
    const out = await recordBakeOff(
      repo,
      "chronicle",
      [
        {
          adapter: new MockInferenceAdapter("w", []),
          settings: childSettings(result),
          passed: 3,
          total: 5,
          minutes: 10,
          tokens: 1000,
          stepBudget: 20,
        },
      ],
      repo,
    );
    const [rec] = readBakeOffRecords(join(repo, ".sekhemet", "bakeoff", "records.jsonl"));
    expect(rec?.candidate).toMatchObject({
      toolArm: "arm_b_json",
      contextTokens: 12_288,
      quant: "IQ3_XXS",
      engine: "llama.cpp",
      settingsFrom: "child evidence",
    });
    expect(out.recorded).toBe(1);
    expect(readFileSync(out.matrix, "utf8")).toMatch(/MODEL_MATRIX/);
  });

  it("marks a record whose child left no evidence settings", async () => {
    const repo = mkdtempSync(join(tmpdir(), "sek-bake-"));
    dirs.push(repo);
    await recordBakeOff(
      repo,
      "chronicle",
      [
        {
          adapter: new MockInferenceAdapter("w", []),
          passed: 0,
          total: 5,
          minutes: 1,
          tokens: 1,
          stepBudget: 20,
        },
      ],
      repo,
    );
    const [rec] = readBakeOffRecords(join(repo, ".sekhemet", "bakeoff", "records.jsonl"));
    expect(rec?.candidate.settingsFrom).toBe("parent adapter (the child recorded none)");
  });
});
