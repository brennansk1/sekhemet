import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerAsset } from "../src/eval_assets.js";
import {
  type GoldenQuestion,
  RESEARCH_GOLDEN_SIZE,
  gradeResearchAnswer,
  loadResearchGoldenSet,
  loadScreeningSets,
  validateGoldenQuestions,
} from "../src/screening_sets.js";

// Design-stage DS-N2-9 and models MD-N11-1: the research golden set — 25
// software questions with checkable answers — its deterministic rubric, and
// the Researcher's screening set drawn from its first five (measurement rules
// 29–31, 30a). Labels are a person's; nothing is scored on a draft.

const ROOT = join(import.meta.dirname, "..", "..", "..");
const DRAFTS = join(ROOT, "fixtures", "research_golden", "drafts", "items.json");
const drafts = () => JSON.parse(readFileSync(DRAFTS, "utf8")) as GoldenQuestion[];

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A copy of the fixtures with the drafts confirmed by a person and registered. */
function confirmed(): string {
  const d = mkdtempSync(join(tmpdir(), "research-golden-"));
  dirs.push(d);
  cpSync(join(ROOT, "fixtures"), join(d, "fixtures"), { recursive: true });
  const dir = join(d, "fixtures", "research_golden");
  const items = drafts().map(({ status: _s, ...q }) => ({
    ...q,
    labelledBy: { principal: "person: Test Owner", kind: "person" as const },
  }));
  writeFileSync(join(dir, "items.json"), JSON.stringify(items, null, 2));
  rmSync(join(dir, "drafts"), { recursive: true });
  return d;
}

function register(root: string) {
  return registerAsset(
    root,
    {
      name: "research-golden-set",
      path: "fixtures/research_golden",
      labelledBy: "person: Test Owner",
    },
    { modelIds: [] },
  );
}

const q = (over: Partial<GoldenQuestion>): GoldenQuestion => ({
  id: "t-1",
  category: "release-date",
  question: "On what date was X 1.0 released?",
  pinned: "x@1.0",
  parts: [{ kind: "date", value: "2023-10-02" }],
  source: "https://example.org/x",
  ...over,
});

describe("the research golden set (DS-N2-9, measurement rule 29)", () => {
  it("drafts 25 questions across API signatures, licences and release dates, each pinned to a version and naming its source", () => {
    const items = drafts();
    expect(items).toHaveLength(RESEARCH_GOLDEN_SIZE);
    expect(new Set(items.map((i) => i.id)).size).toBe(25);
    const kinds = new Set(items.map((i) => i.category));
    expect(kinds).toEqual(new Set(["api-signature", "licence", "release-date"]));
    for (const i of items) {
      expect(i.pinned, i.id).toMatch(/@\d/);
      expect(i.source, i.id).toMatch(/^https:\/\//);
    }
    expect(validateGoldenQuestions(items)).toEqual([]);
    // Some questions have two parts, so a partly right answer can score ½.
    expect(items.filter((i) => i.parts.length > 1).length).toBeGreaterThanOrEqual(3);
  });

  it("no question gives its answer away: graded as its own answer, the question is never right (MS-T11-3)", () => {
    for (const item of drafts()) {
      const g = gradeResearchAnswer(item, { text: item.question, verifiedCitations: 1 });
      expect(g.partsRight.some(Boolean), item.id).toBe(false);
    }
  });

  it("refuses a malformed question: an unknown licence, a date that is not ISO, a part with no value", () => {
    expect(
      validateGoldenQuestions([q({ parts: [{ kind: "licence", value: "WTFPL-9" }] })]),
    ).toEqual(["t-1: licence WTFPL-9 is not one the rubric reads"]);
    expect(
      validateGoldenQuestions([q({ parts: [{ kind: "date", value: "2 Oct 2023" }] })])[0],
    ).toMatch(/not an ISO date/);
    expect(validateGoldenQuestions([q({ parts: [] })])[0]).toMatch(/no parts/);
    expect(validateGoldenQuestions([q({ source: "" })])[0]).toMatch(/no source/);
  });

  it("stays not_built while the answers are drafts: nothing is scored on a model's labels", () => {
    const set = loadResearchGoldenSet(ROOT);
    expect(set.state).toBe("not_built");
    expect(set.reason).toMatch(/a person/);
    expect(set.reason).toMatch(/research_golden\/drafts\/README\.md/);
    expect(set.items).toEqual([]);
  });

  it("is ready once a person confirms and registers it, versioned with the asset's hash", () => {
    const root = confirmed();
    const { entry } = register(root);
    const set = loadResearchGoldenSet(root);
    expect(set.state).toBe("ready");
    expect(set.items).toHaveLength(25);
    expect(set.hash).toBe(entry.hash);
    expect(set.version).toBe("1");
  });

  it("scores the files the manifest's hash pins, wherever the set is registered", () => {
    const root = confirmed();
    const moved = join(root, "fixtures", "research_golden_v2");
    cpSync(join(root, "fixtures", "research_golden"), moved, { recursive: true });
    rmSync(join(root, "fixtures", "research_golden"), { recursive: true });
    const { entry } = registerAsset(
      root,
      {
        name: "research-golden-set",
        path: "fixtures/research_golden_v2",
        labelledBy: "person: Test Owner",
      },
      { modelIds: [] },
    );
    const set = loadResearchGoldenSet(root);
    expect(set.state).toBe("ready");
    expect(set.items).toHaveLength(25);
    expect(set.hash).toBe(entry.hash);
  });

  it("refuses a registered set whose items were edited in place, and one a model labelled", () => {
    const root = confirmed();
    register(root);
    const path = join(root, "fixtures", "research_golden", "items.json");
    const items = JSON.parse(readFileSync(path, "utf8")) as GoldenQuestion[];
    (items[0] as GoldenQuestion).parts[0] = { kind: "text", value: "anything" };
    writeFileSync(path, JSON.stringify(items));
    expect(loadResearchGoldenSet(root)).toMatchObject({ state: "not_built" });
    expect(loadResearchGoldenSet(root).reason).toMatch(/does not match the manifest/);

    const root2 = confirmed();
    const path2 = join(root2, "fixtures", "research_golden", "items.json");
    const byModel = JSON.parse(readFileSync(path2, "utf8")) as GoldenQuestion[];
    (byModel[3] as GoldenQuestion).labelledBy = { principal: "claude-opus-5-5", kind: "model" };
    writeFileSync(path2, JSON.stringify(byModel));
    expect(() => register(root2)).toThrow(/labelled only by a model/);
  });
});

describe("the rubric: 0, ½ or 1, deterministic (MS-N5-3, MD-N11-1)", () => {
  const byId = (id: string) => drafts().find((i) => i.id === id) as GoldenQuestion;

  it("reads a date in any usual form, and a conflicting date makes it wrong", () => {
    const item = byId("rg-03");
    for (const text of [
      "Python 3.12.0 was released on 2023-10-02 [1].",
      "It shipped on October 2, 2023.",
      "Released 2 October 2023.",
      "Released Oct 2nd, 2023.",
    ])
      expect(gradeResearchAnswer(item, { text, verifiedCitations: 1 }).grade, text).toBe(1);
    expect(
      gradeResearchAnswer(item, { text: "Released 3 October 2023.", verifiedCitations: 1 }).grade,
    ).toBe(0);
    // A second date in the body is context, not a conflict, unless the item names it.
    const withConflict = q({
      parts: [{ kind: "date", value: "2023-10-02", conflicts: ["2023-10-03"] }],
    });
    expect(
      gradeResearchAnswer(withConflict, {
        text: "Either 2023-10-02 or 2023-10-03.",
        verifiedCitations: 1,
      }).grade,
    ).toBe(0);
  });

  it("reads a licence under its usual names, and a named conflicting licence makes it wrong", () => {
    const requests = byId("rg-08");
    expect(
      gradeResearchAnswer(requests, {
        text: "requests is licensed under the Apache License, Version 2.0.",
        verifiedCitations: 2,
      }).grade,
    ).toBe(1);
    expect(
      gradeResearchAnswer(requests, { text: "It is MIT or Apache 2.0.", verifiedCitations: 1 })
        .grade,
    ).toBe(0);
    expect(
      gradeResearchAnswer(byId("rg-05"), {
        text: "SQLite is in the public domain.",
        verifiedCitations: 1,
      }).grade,
    ).toBe(1);
    expect(
      gradeResearchAnswer(byId("rg-15"), {
        text: "Redis 7.2 uses the 3-clause BSD license.",
        verifiedCitations: 1,
      }).grade,
    ).toBe(1);
    // "MIT" is a word, not a substring of another.
    expect(
      gradeResearchAnswer(byId("rg-02"), { text: "It is SUBMITTED to npm.", verifiedCitations: 1 })
        .grade,
    ).toBe(0);
  });

  it("reads a signature with spaces ignored and a version standing alone", () => {
    const item = byId("rg-04");
    const good = "Added in Python 3.9. Signature: str.removeprefix(prefix,/)";
    expect(gradeResearchAnswer(item, { text: good, verifiedCitations: 1 })).toMatchObject({
      grade: 1,
      correct: true,
      partsRight: [true, true],
    });
    // 3.90 is not 3.9; one part of two right scores ½.
    const half = gradeResearchAnswer(item, {
      text: "Added in 3.90; str.removeprefix(prefix, /)",
      verifiedCitations: 1,
    });
    expect(half).toMatchObject({ grade: 0.5, correct: false, partsRight: [false, true] });
    // A conflicting version named makes the part wrong.
    expect(
      gradeResearchAnswer(item, {
        text: "Added in 3.8 or 3.9: str.removeprefix(prefix, /)",
        verifiedCitations: 1,
      }).grade,
    ).toBe(0.5);
  });

  it("scores an unsourced answer 0 however right, and reads only the body before References", () => {
    const item = byId("rg-02");
    expect(gradeResearchAnswer(item, { text: "MIT.", verifiedCitations: 0 })).toMatchObject({
      grade: 0,
      correct: false,
      sourced: false,
      partsRight: [true],
    });
    expect(
      gradeResearchAnswer(item, {
        text: "I could not tell.\n\nReferences:\n[1] https://example.org/MIT-license",
        verifiedCitations: 1,
      }).grade,
    ).toBe(0);
  });
});

describe("the Researcher's screening set: the golden set's first five over a cached corpus (rule 30a)", () => {
  it("reads not_built while the golden set is a draft, naming it", () => {
    const r = loadScreeningSets(ROOT).roles.researcher;
    expect(r.state).toBe("not_built");
    expect(r.reason).toMatch(/research golden set/);
    expect(r.hash).toBeUndefined();
  });

  it("reads not_built when the golden set is registered but the cached corpus is missing", () => {
    const root = confirmed();
    register(root);
    const r = loadScreeningSets(root).roles.researcher;
    expect(r.state).toBe("not_built");
    expect(r.reason).toMatch(/cached offline corpus/);
    expect(r.reason).toMatch(/rg-01/);
  });

  it("is ready over a corpus pinned by hash, the first five questions, and its hash covers the asset", () => {
    const root = confirmed();
    const dir = join(root, "fixtures", "research_golden", "corpus");
    mkdirSync(dir, { recursive: true });
    const index = drafts()
      .slice(0, 5)
      .map((i) => {
        const body = `<html>${i.id}</html>`;
        writeFileSync(join(dir, `${i.id}.html`), body);
        return {
          id: i.id,
          url: i.source,
          file: `${i.id}.html`,
          sha256: createHash("sha256").update(body).digest("hex"),
        };
      });
    writeFileSync(join(dir, "index.json"), JSON.stringify(index));
    const { entry } = register(root);
    const r = loadScreeningSets(root).roles.researcher;
    expect(r.state).toBe("ready");
    expect(r.items.map((i) => i.id)).toEqual(["rg-01", "rg-02", "rg-03", "rg-04", "rg-05"]);
    expect(r.items[0]?.question).toMatch(/itertools\.batched/);
    expect(r.items[0]?.corpus).toEqual(["corpus/rg-01.html"]);
    expect(r.capSeconds).toBe(60);
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.hash).not.toBe(entry.hash);

    // A corpus page that no longer matches its pinned hash is refused, even
    // when the asset was re-registered around it.
    writeFileSync(join(dir, "rg-02.html"), "<html>changed</html>");
    expect(register(root).changed).toBe("new version");
    const after = loadScreeningSets(root).roles.researcher;
    expect(after.state).toBe("not_built");
    expect(after.reason).toMatch(/rg-02\.html does not match its pinned hash/);
  });
});
