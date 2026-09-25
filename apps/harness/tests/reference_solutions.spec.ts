import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AssetLabel,
  assetSizeReport,
  loadAssetManifest,
  validateAssetLabels,
  verifyAsset,
} from "@sekhemet/eval";
import { describe, expect, it } from "vitest";

// Measurement rule 8 and 29, MS-T7-2, MS-T11-2, MS-T11-4 and MS-T11-6: the
// frozen suite's reference solutions are a registered evaluation asset. Each
// counts only with a recorded run of its card's frozen test that failed at
// the seed and passed on the solution (scripts/verify_reference_solutions.mjs
// writes the record; this test reads it, it does not rerun the cards).

const ROOT = join(import.meta.dirname, "..", "..", "..");
const DIR = join(ROOT, "fixtures", "reference_solutions");

interface Run {
  exitCode: number;
  passed: number;
  total: number;
  outputSha256: string;
  typecheckExitCode?: number;
}

interface Item {
  id: string;
  fixture: string;
  card: string;
  files: { path: string; sha256: string }[];
  acceptanceTests: string[];
  provenance: string;
  verification: {
    command: string;
    atSeed: Run;
    onReference: Run;
    typecheck: { exitCode: number };
    lint: { exitCode: number };
  };
  labelledBy: AssetLabel;
}

const items = (): Item[] => JSON.parse(readFileSync(join(DIR, "items.json"), "utf8")) as Item[];

describe("the reference solutions asset (T11)", () => {
  it("is registered, and its content hash and item count match the manifest", () => {
    const entry = loadAssetManifest(ROOT).assets.find((a) => a.name === "reference-solutions");
    expect(entry?.path).toBe("fixtures/reference_solutions");
    const verified = verifyAsset(ROOT, "reference-solutions");
    expect(verified.hash).toBe(entry?.hash);
    expect(verified.items).toBe(entry?.items);
    expect(items()).toHaveLength(entry?.items ?? -1);
  });

  it("holds one verified solution per frozen-suite card, as rule 29 requires", () => {
    const suite = JSON.parse(readFileSync(join(ROOT, "fixtures", "suite.json"), "utf8")) as {
      fixtures: { name: string; tasks: number }[];
    };
    const expected = suite.fixtures.reduce((n, f) => n + f.tasks, 0);
    const ids = items().map((i) => i.id);
    expect(new Set(ids).size).toBe(expected);
    for (const f of suite.fixtures) {
      expect(
        ids.filter((id) => id.startsWith(`${f.name}/`)),
        f.name,
      ).toHaveLength(f.tasks);
    }
    const report = assetSizeReport(loadAssetManifest(ROOT), "B2.4").find(
      (r) => r.name === "reference-solutions",
    );
    expect(report?.status).toBe("ok");
  });

  it("labels every item by its executed frozen test, never by a model alone (MS-T11-4)", () => {
    expect(validateAssetLabels(items())).toEqual([]);
    for (const item of items()) {
      expect(item.labelledBy, item.id).toEqual({
        principal: "frozen tests",
        kind: "executed",
        passedFrozenTests: true,
      });
      expect(item.provenance).toBe(
        "written by an agent (claude-opus-5-5), verified by the frozen tests",
      );
    }
  });

  it("records, for each solution, a frozen-test run that failed at the seed and passed on it (MS-T7-2)", () => {
    for (const item of items()) {
      const { atSeed, onReference, command, typecheck, lint } = item.verification;
      expect(command, item.id).toBe(`vitest run ${item.acceptanceTests.join(" ")}`);
      // A types-only card's test passes at run time on an empty file; its
      // typecheck over the staged test is what fails at the seed.
      expect(atSeed.exitCode !== 0 || atSeed.typecheckExitCode !== 0, item.id).toBe(true);
      expect(onReference.exitCode, item.id).toBe(0);
      expect(onReference.total, item.id).toBeGreaterThan(0);
      expect(onReference.passed, item.id).toBe(onReference.total);
      expect(onReference.outputSha256, item.id).toMatch(/^[0-9a-f]{64}$/);
      expect([typecheck.exitCode, lint.exitCode], item.id).toEqual([0, 0]);
    }
  });

  it("holds exactly the recorded files of each solution", () => {
    for (const item of items()) {
      expect(item.files.length, item.id).toBeGreaterThan(0);
      for (const file of item.files) {
        const path = join(DIR, item.fixture, item.card, file.path);
        expect(existsSync(path), path).toBe(true);
        expect(createHash("sha256").update(readFileSync(path)).digest("hex"), path).toBe(
          file.sha256,
        );
      }
    }
  });
});
