import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashAssetDir } from "../src/eval_assets.js";
import { SCREENING_SET_SIZE, loadScreeningSets } from "../src/screening_sets.js";

// Measurement rules 29–31, 30a (MS-N5-3, MS-N5-4b): each role's small, fixed,
// versioned screening set; a set a workstream has not built reads not_built,
// and no role is ever scored on a partial set (MS-T11-7).

const ROOT = join(import.meta.dirname, "..", "..", "..");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function copyRepo(): string {
  const d = mkdtempSync(join(tmpdir(), "screening-"));
  dirs.push(d);
  cpSync(join(ROOT, "fixtures"), join(d, "fixtures"), { recursive: true });
  return d;
}

describe("the screening sets (measurement rule 31)", () => {
  it("builds the Worker's set: six frozen-suite cards across kinds, capped at 2 minutes, each with its reference solution and acceptance tests", () => {
    const sets = loadScreeningSets(ROOT);
    const w = sets.roles.worker;
    expect(w.state).toBe("ready");
    expect(w.items).toHaveLength(SCREENING_SET_SIZE.worker);
    expect(w.capSeconds).toBe(120);
    expect(new Set(w.items.map((i) => i.kind)).size).toBeGreaterThanOrEqual(4);
    expect(w.hash).toMatch(/^[0-9a-f]{64}$/);
    const refs = JSON.parse(
      readFileSync(join(ROOT, "fixtures", "reference_solutions", "items.json"), "utf8"),
    ) as { id: string; verification: { atSeed: { passed: number; total: number } } }[];
    for (const item of w.items) {
      const ref = refs.find((r) => r.id === item.id);
      expect(ref, item.id).toBeDefined();
      // A card passing at seed would score 1 whatever the model did.
      expect(ref?.verification.atSeed.passed, item.id).toBeLessThan(
        ref?.verification.atSeed.total ?? 0,
      );
      expect(item.referenceSeconds ?? 999, item.id).toBeLessThan(120);
      for (const t of item.acceptanceTests ?? [])
        expect(existsSync(join(ROOT, "fixtures", item.fixture ?? "", "acceptance", t))).toBe(true);
    }
    expect(sets.endToEnd.items).toHaveLength(2);
    expect(sets.endToEnd.capSeconds).toBe(180);
  });

  it("keeps the Planner not_built until the golden briefs are labelled by a person and registered", () => {
    const p = loadScreeningSets(ROOT).roles.planner;
    expect(p.state).toBe("not_built");
    expect(p.reason).toMatch(/golden briefs/);
    expect(p.hash).toBeUndefined();
  });

  it("reads the Reviewer's set from 10 registered seeded defects (C3-4, CFG-17), and the Researcher's as not_built until a person registers the research golden set", () => {
    const sets = loadScreeningSets(ROOT);
    expect(sets.roles.reviewer).toMatchObject({ state: "ready", expectedSize: 10 });
    expect(sets.roles.reviewer.items).toHaveLength(10);
    // B4.4 built the set (research_golden.spec.ts); its answers wait on a person's labels.
    expect(sets.roles.researcher).toMatchObject({ state: "not_built" });
    expect(sets.roles.researcher.reason).toMatch(/research golden set is a draft/);
  });

  it("never offers a partial set: a Worker set short of six cards is not_built", () => {
    const repo = copyRepo();
    const path = join(repo, "fixtures", "screening", "worker.json");
    const set = JSON.parse(readFileSync(path, "utf8"));
    set.items = set.items.slice(0, 5);
    writeFileSync(path, JSON.stringify(set));
    const w = loadScreeningSets(repo).roles.worker;
    expect(w.state).toBe("not_built");
    expect(w.reason).toMatch(/5 of 6/);
  });

  it("changes the set's hash when an acceptance test it names changes", () => {
    const repo = copyRepo();
    const before = loadScreeningSets(repo).roles.worker.hash;
    const test = join(repo, "fixtures", "onyx", "acceptance", "db.spec.ts");
    writeFileSync(test, `${readFileSync(test, "utf8")}\n// changed\n`);
    expect(loadScreeningSets(repo).roles.worker.hash).not.toBe(before);
  });

  it("builds the Planner's set once registered golden briefs hold its three briefs", () => {
    const repo = copyRepo();
    const briefs = JSON.parse(
      readFileSync(join(repo, "fixtures", "golden_briefs", "drafts", "items.json"), "utf8"),
    ) as Record<string, unknown>[];
    const labelled = briefs.map((b) => {
      const { status: _status, ...rest } = b;
      return { ...rest, labelledBy: { principal: "person: Test Owner", kind: "person" } };
    });
    writeFileSync(join(repo, "fixtures", "golden_briefs", "items.json"), JSON.stringify(labelled));
    const manifestPath = join(repo, "fixtures", "eval_assets.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.assets.push({
      name: "golden-briefs",
      version: "1",
      hash: hashAssetDir(join(repo, "fixtures", "golden_briefs")),
      items: labelled.length,
      labelledBy: "person: Test Owner",
      provenance: "test",
      usedBy: ["MS-T7-7"],
      builtIn: "B2.4",
      path: "fixtures/golden_briefs",
      versions: [],
    });
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const p = loadScreeningSets(repo).roles.planner;
    expect(p.state).toBe("ready");
    expect(p.items.map((i) => i.id)).toEqual(["b01", "b05", "b09"]);
    expect(p.items[0]?.requirements?.length).toBeGreaterThan(0);
  });
});
