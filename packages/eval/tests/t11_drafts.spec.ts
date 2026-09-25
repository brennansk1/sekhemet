import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EVAL_ASSET_PLAN, loadAssetManifest, registerAsset } from "../src/eval_assets.js";

// Measurement T11 and DEC-42: the golden briefs and the held-out acceptance
// suite are drafted on the lead's side and stay DRAFTS — unregistered, with
// no labelling principal — until a person confirms each item.

const ROOT = join(import.meta.dirname, "..", "..", "..");
const DRAFT = "draft — awaiting a person's confirmation";
const read = <T>(p: string) => JSON.parse(readFileSync(join(ROOT, p), "utf8")) as T;

interface Brief {
  id: string;
  title: string;
  audience: string;
  brief: string;
  implicitRequirements: { id: string; text: string }[];
  status?: string;
  labelledBy?: unknown;
}
interface HeldOut {
  id: string;
  kind: "brief" | "fixture";
  briefId?: string;
  fixture?: string;
  file?: string;
  checks?: { id: string; covers: string; check: string }[];
  status?: string;
  labelledBy?: unknown;
}

const briefs = read<Brief[]>("fixtures/golden_briefs/drafts/items.json");
const heldOut = read<HeldOut[]>("fixtures/held_out/drafts/items.json");
const suite = read<{ fixtures: { name: string }[] }>("fixtures/suite.json");

describe("golden briefs, drafted (MS-T7-7)", () => {
  it("meets rule 29's size, includes people who do not write software, and each brief lists its implicit requirements", () => {
    const plan = EVAL_ASSET_PLAN.find((p) => p.name === "golden-briefs");
    expect(briefs.length).toBeGreaterThanOrEqual(plan?.minItems ?? 10);
    expect(briefs.filter((b) => b.audience === "non-developer").length).toBeGreaterThanOrEqual(3);
    const ids = briefs.flatMap((b) => [b.id, ...b.implicitRequirements.map((r) => r.id)]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const b of briefs) {
      expect(b.brief.length, b.id).toBeGreaterThan(80);
      expect(b.implicitRequirements.length, b.id).toBeGreaterThanOrEqual(3);
      expect(
        b.implicitRequirements.every((r) => r.id.startsWith(`${b.id}-r`)),
        b.id,
      ).toBe(true);
    }
  });

  it("is every item a draft with no labelling principal", () => {
    for (const b of briefs) {
      expect(b.status, b.id).toBe(DRAFT);
      expect(b.labelledBy, b.id).toBeUndefined();
    }
  });
});

describe("held-out acceptance suite, drafted (MS-T7-8)", () => {
  it("holds one item per brief and one per frozen-suite fixture, each check covering an implicit requirement", () => {
    const plan = EVAL_ASSET_PLAN.find((p) => p.name === "held-out-acceptance-suite");
    expect(heldOut.length).toBeGreaterThanOrEqual(plan?.minItems ?? 14);
    expect(heldOut.filter((h) => h.kind === "brief").map((h) => h.briefId)).toEqual(
      briefs.map((b) => b.id),
    );
    expect(heldOut.filter((h) => h.kind === "fixture").map((h) => h.fixture)).toEqual(
      suite.fixtures.map((f) => f.name),
    );
    const reqs = new Set(briefs.flatMap((b) => b.implicitRequirements.map((r) => r.id)));
    for (const h of heldOut.filter((x) => x.kind === "brief")) {
      expect(h.checks?.length, h.id).toBeGreaterThan(0);
      expect(
        h.checks?.every((c) => reqs.has(c.covers)),
        h.id,
      ).toBe(true);
    }
    for (const h of heldOut) {
      expect(h.status, h.id).toBe(DRAFT);
      expect(h.labelledBy, h.id).toBeUndefined();
    }
  });

  it("proves each fixture test: it fails on the seed and passes on the reference solutions' final main, for the file as it is now", () => {
    const { proof } = read<{
      proof: {
        fixture: string;
        fileSha256: string;
        atSeed: { exitCode: number };
        onReferenceMain: { exitCode: number; passed: number; total: number };
        referenceSolutions: { version: string };
      }[];
    }>("fixtures/held_out/drafts/proof.json");
    const refs = loadAssetManifest(ROOT).assets.find((a) => a.name === "reference-solutions");
    for (const h of heldOut.filter((x) => x.kind === "fixture")) {
      const p = proof.find((x) => x.fixture === h.fixture);
      expect(p, h.id).toBeDefined();
      const file = join(ROOT, "fixtures", "held_out", "drafts", h.file as string);
      expect(
        p?.fileSha256,
        `${h.id}: the proof is for another version of the file; rerun scripts/verify_held_out.mjs --record`,
      ).toBe(createHash("sha256").update(readFileSync(file)).digest("hex"));
      expect(p?.atSeed.exitCode, h.id).not.toBe(0);
      expect(p?.onReferenceMain.exitCode, h.id).toBe(0);
      expect(p?.onReferenceMain.passed, h.id).toBe(p?.onReferenceMain.total);
      expect(p?.onReferenceMain.total, h.id).toBeGreaterThan(0);
      expect(p?.referenceSolutions.version).toBe(refs?.version);
    }
  });
});

describe("neither draft is registered, and the asset API would refuse them as they are", () => {
  it("is absent from the manifest", () => {
    const names = loadAssetManifest(ROOT).assets.map((a) => a.name);
    expect(names).not.toContain("golden-briefs");
    expect(names).not.toContain("held-out-acceptance-suite");
  });

  it("refuses to register an unlabelled draft", () => {
    const r = mkdtempSync(join(tmpdir(), "t11-drafts-"));
    cpSync(
      join(ROOT, "fixtures", "golden_briefs", "drafts"),
      join(r, "fixtures", "golden_briefs"),
      {
        recursive: true,
      },
    );
    writeFileSync(
      join(r, "fixtures", "eval_assets.json"),
      JSON.stringify({ about: "", assets: [] }),
    );
    expect(existsSync(join(r, "fixtures", "golden_briefs", "items.json"))).toBe(true);
    expect(() =>
      registerAsset(r, {
        name: "golden-briefs",
        path: "fixtures/golden_briefs",
        labelledBy: "person: Tester",
      }),
    ).toThrow(/b01: no labelling principal/);
  });
});
