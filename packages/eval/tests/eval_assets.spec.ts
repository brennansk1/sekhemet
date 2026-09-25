import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AssetEntry,
  type AssetManifest,
  EVAL_ASSET_PLAN,
  assetSizeReport,
  comparableResults,
  hashAssetDir,
  loadAssetManifest,
  recordAssetVersion,
  registerAsset,
  validateAssetEntry,
  validateAssetLabels,
  verifyAsset,
} from "../src/eval_assets.js";

// measurement.md rule 29 and T11: evaluation assets are versioned, hashed,
// labelled by a person or by execution, and never scored when absent.

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/** A repository with one asset of `items` items under fixtures/eval_assets/<name>/. */
function repo(name = "golden-briefs", items = 10): { root: string; entry: AssetEntry } {
  const root = mkdtempSync(join(tmpdir(), "assets-"));
  dirs.push(root);
  const dir = join(root, "fixtures", "eval_assets", name);
  mkdirSync(dir, { recursive: true });
  const list = Array.from({ length: items }, (_, i) => ({
    id: `brief-${i}`,
    labelledBy: { principal: "owner", kind: "person" },
  }));
  writeFileSync(join(dir, "items.json"), JSON.stringify(list));
  const entry: AssetEntry = {
    name,
    version: "1",
    hash: hashAssetDir(dir),
    items,
    labelledBy: "owner",
    usedBy: ["MS-T7-7"],
    heldOut: "the annotations, from the Planner and Seshat",
    builtIn: "B2.4",
    path: `fixtures/eval_assets/${name}`,
    versions: [],
  };
  const manifest: AssetManifest = { about: "test", assets: [entry] };
  writeFileSync(join(root, "fixtures", "eval_assets.json"), JSON.stringify(manifest));
  return { root, entry };
}

describe("the manifest (MS-T11-1)", () => {
  it("refuses an entry missing any required field", () => {
    const { entry } = repo();
    expect(validateAssetEntry(entry)).toEqual([]);
    const { labelledBy: _l, usedBy: _u, ...partial } = entry;
    expect(validateAssetEntry(partial as AssetEntry)).toEqual([
      "golden-briefs: missing labelledBy",
      "golden-briefs: missing usedBy",
    ]);
  });

  it("refuses to load a manifest with an invalid entry", () => {
    const { root, entry } = repo();
    writeFileSync(
      join(root, "fixtures", "eval_assets.json"),
      JSON.stringify({ about: "x", assets: [{ ...entry, hash: "" }] }),
    );
    expect(() => loadAssetManifest(root)).toThrow(/golden-briefs: missing hash/);
  });
});

describe("scoring against an asset (MS-T11-2, MS-T11-7)", () => {
  it("returns the asset's hash when it matches the manifest", () => {
    const { root, entry } = repo();
    expect(verifyAsset(root, "golden-briefs")).toMatchObject({ hash: entry.hash, items: 10 });
  });

  it("refuses a changed asset, naming it", () => {
    const { root } = repo();
    writeFileSync(join(root, "fixtures", "eval_assets", "golden-briefs", "extra.json"), "{}");
    expect(() => verifyAsset(root, "golden-briefs")).toThrow(/golden-briefs.*hash/);
  });

  it("refuses fewer items than the manifest declares", () => {
    const { root, entry } = repo();
    const manifest = JSON.parse(readFileSync(join(root, "fixtures", "eval_assets.json"), "utf8"));
    manifest.assets[0] = { ...entry, items: 12 };
    writeFileSync(join(root, "fixtures", "eval_assets.json"), JSON.stringify(manifest));
    expect(() => verifyAsset(root, "golden-briefs")).toThrow(/10 items, the manifest declares 12/);
  });

  it("refuses an asset not in the manifest, naming the workstream that builds it", () => {
    const { root } = repo();
    expect(() => verifyAsset(root, "held-out-acceptance-suite")).toThrow(
      /held-out-acceptance-suite is not registered.*built in B2\.4/,
    );
  });

  it("compares two results only when their asset hashes match", () => {
    expect(comparableResults({ assetHash: "a" }, { assetHash: "a" })).toBe(true);
    expect(comparableResults({ assetHash: "a" }, { assetHash: "b" })).toBe(false);
  });
});

describe("labels (MS-T11-4)", () => {
  it("refuses a label whose only source is a model", () => {
    expect(
      validateAssetLabels([
        { id: "a", labelledBy: { principal: "owner", kind: "person" } },
        { id: "b", labelledBy: { principal: "qwen3", kind: "model" } },
        { id: "c" },
      ]),
    ).toEqual(["b: labelled only by a model (qwen3)", "c: no labelling principal"]);
  });

  it("counts a reference solution as labelled only when it passed its card's frozen tests", () => {
    expect(
      validateAssetLabels([
        {
          id: "card_1",
          labelledBy: { principal: "frozen tests", kind: "executed", passedFrozenTests: true },
        },
        {
          id: "card_2",
          labelledBy: { principal: "frozen tests", kind: "executed", passedFrozenTests: false },
        },
      ]),
    ).toEqual(["card_2: an executed label must pass its card's frozen tests"]);
  });
});

describe("versions (MS-T11-5)", () => {
  it("records a new version and keeps the earlier version's hash", () => {
    const { root, entry } = repo();
    const manifest = loadAssetManifest(root);
    const next = recordAssetVersion(manifest, "golden-briefs", { hash: "newhash", items: 11 });
    const e = next.assets.find((a) => a.name === "golden-briefs");
    expect(e).toMatchObject({ version: "2", hash: "newhash", items: 11 });
    expect(e?.versions).toEqual([{ version: "1", hash: entry.hash, items: 10 }]);
  });
});

describe("sizes against rule 29's table (MS-T11-6)", () => {
  it("has a plan row for every asset of rule 29, with its minimum and workstream", () => {
    const names = EVAL_ASSET_PLAN.map((p) => p.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "reference-solutions",
        "golden-briefs",
        "held-out-acceptance-suite",
        "injection-fixtures",
        "labelled-ui-screens",
        "research-golden-set",
        "project-starts",
        "labelled-reuse-set",
        "reviewer-seeded-defects",
        "pm-conversations",
      ]),
    );
    expect(EVAL_ASSET_PLAN.find((p) => p.name === "golden-briefs")).toMatchObject({
      minItems: 10,
      builtIn: "B2.4",
    });
    expect(EVAL_ASSET_PLAN.find((p) => p.name === "reference-solutions")?.minItems).toBe(30);
  });

  it("reports each B2.4 asset as missing, short or at size, so the workstream cannot close short", () => {
    const { root } = repo("golden-briefs", 7);
    const report = assetSizeReport(loadAssetManifest(root), "B2.4");
    expect(report).toEqual([
      { name: "reference-solutions", required: 30, registered: 0, status: "missing" },
      { name: "golden-briefs", required: 10, registered: 7, status: "short" },
      { name: "held-out-acceptance-suite", required: 14, registered: 0, status: "missing" },
    ]);
  });
});

describe("registering an asset through the API, not hand-written JSON", () => {
  const root = () => {
    const r = mkdtempSync(join(tmpdir(), "assets-reg-"));
    mkdirSync(join(r, "fixtures", "ref"), { recursive: true });
    writeFileSync(
      join(r, "fixtures", "eval_assets.json"),
      JSON.stringify({ about: "the manifest's own words", assets: [] }),
    );
    writeFileSync(join(r, "fixtures", "ref", "items.json"), JSON.stringify([item("a"), item("b")]));
    return r;
  };
  const item = (id: string) => ({
    id,
    labelledBy: { principal: "frozen tests", kind: "executed", passedFrozenTests: true },
  });
  const spec = {
    name: "reference-solutions",
    path: "fixtures/ref",
    labelledBy: "frozen tests",
    provenance: "written by an agent, verified by the frozen tests",
  };

  it("validates and writes a new entry with its hash, item count, provenance and plan, keeping the manifest's other keys", () => {
    const r = root();
    const out = registerAsset(r, spec);
    expect(out.changed).toBe("registered");
    const raw = JSON.parse(readFileSync(join(r, "fixtures", "eval_assets.json"), "utf8"));
    expect(raw.about).toBe("the manifest's own words");
    expect(raw.assets[0]).toMatchObject({
      name: "reference-solutions",
      version: "1",
      items: 2,
      hash: hashAssetDir(join(r, "fixtures", "ref")),
      provenance: spec.provenance,
      usedBy: ["MS-T7-2", "MS-T7-3", "CX-P1-5"],
      builtIn: "B2.4",
      versions: [],
    });
    expect(verifyAsset(r, "reference-solutions").items).toBe(2);
  });

  it("writes a new version when the content changes, keeps the earlier hash, and does nothing when it does not", () => {
    const r = root();
    const first = registerAsset(r, spec).entry;
    expect(registerAsset(r, spec).changed).toBe("unchanged");
    writeFileSync(join(r, "fixtures", "ref", "items.json"), JSON.stringify([item("a")]));
    const next = registerAsset(r, spec);
    expect(next.changed).toBe("new version");
    expect(next.entry).toMatchObject({ version: "2", items: 1 });
    expect(next.entry.versions).toEqual([{ version: "1", hash: first.hash, items: 2 }]);
  });

  it("refuses an entry that would be incomplete, or labelled by a model", () => {
    const r = root();
    expect(() => registerAsset(r, { ...spec, labelledBy: "" })).toThrow(/missing labelledBy/);
    expect(() => registerAsset(r, { ...spec, name: "not-in-the-plan" })).toThrow(
      /not in rule 29's plan/,
    );
    expect(() => registerAsset(r, { ...spec, labelledBy: "a model" })).toThrow(/never a model's/);
    // Only an allowed principal form is accepted, not merely one without the word "model" (review M6).
    expect(() => registerAsset(r, { ...spec, labelledBy: "claude-opus-5-5" })).toThrow(
      /never a model's/,
    );
    // A model's name dressed as a person is still a model's label (review M6 loophole).
    for (const name of [
      "person: claude-opus-5-5",
      "person: GPT-5",
      "publisher: qwen3-coder",
      "person: cyber-tiel",
    ])
      expect(() => registerAsset(r, { ...spec, labelledBy: name })).toThrow(/names a model/);
    expect(registerAsset(r, { ...spec, labelledBy: "person: Brennan" }).changed).toBe("registered");
  });

  it("refuses items labelled only by a model, or not labelled at all (review M6)", () => {
    const r = root();
    writeFileSync(
      join(r, "fixtures", "ref", "items.json"),
      JSON.stringify([
        item("a"),
        { id: "b", labelledBy: { principal: "claude-opus-5-5", kind: "model" } },
      ]),
    );
    expect(() => registerAsset(r, spec)).toThrow(/b: labelled only by a model/);
    writeFileSync(join(r, "fixtures", "ref", "items.json"), JSON.stringify([{ id: "c" }]));
    expect(() => registerAsset(r, spec)).toThrow(/c: no labelling principal/);
    writeFileSync(
      join(r, "fixtures", "ref", "items.json"),
      JSON.stringify([{ id: "d", labelledBy: { principal: "claude-opus-5-5", kind: "person" } }]),
    );
    expect(() => registerAsset(r, spec)).toThrow(/d: .*names a model/);
    // So does a name the model registry knows.
    writeFileSync(
      join(r, "fixtures", "ref", "items.json"),
      JSON.stringify([{ id: "e", labelledBy: { principal: "house-worker-9", kind: "person" } }]),
    );
    expect(() => registerAsset(r, spec, { modelIds: ["house-worker-9"] })).toThrow(
      /e: .*names a model/,
    );
  });
});
