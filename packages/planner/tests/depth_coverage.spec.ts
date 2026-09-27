import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, checklistRowsFor, initSchema } from "@sekhemet/kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Comparable,
  checklistWordsFor,
  claimsCompliance,
  commonFeatures,
  comparablesQuery,
  proposeDepthProfile,
  recordDepthChoice,
  surveyComparables,
  walkStoryMap,
} from "../src/depth_profile.js";
import { designStage, renderBrief } from "../src/design_stage.js";
import type { PlannerLedger } from "../src/ledger.js";
import { acceptBrief } from "../src/requirement_graph.js";

// design-stage P14 (DS-P14-1, -2, -4, -5, -6, -7, -9): the depth profile
// proposed with its reason and chosen by a person, the checklist's words, the
// comparables and the story map's walkthrough — over the kernel's records on
// a real SQLite file.

const OWNER = "p_owner";
let dir: string;
let db: DatabaseSync;
let store: CardStore;
let ledger: PlannerLedger;
let projectId: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "planner-depth-coverage-"));
  db = new DatabaseSync(join(dir, "events.db"));
  initSchema(db);
  const log = new EventLog(db);
  store = new CardStore(db, log);
  ledger = { store, log };
  projectId = (await store.ensureProject({ rootPath: dir, name: "Recipes" })).id;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const RECIPES = "a recipe website where people can sign up and save favourites";

describe("DS-P14-1: a depth profile is proposed with its reason, and a person's choice recorded", () => {
  it("proposes by what is at stake", () => {
    const cases: [string, string][] = [
      ["build me a calculator", "prototype"],
      ["a CLI that syncs my notes to S3", "internal tool"],
      [RECIPES, "production"],
      ["a patient records service for a clinic, HIPAA audited", "regulated"],
    ];
    for (const [spec, profile] of cases) {
      const d = designStage(spec, { greenfield: true });
      expect(d.depth?.profile, spec).toBe(profile);
      expect(d.depth?.reason.length, spec).toBeGreaterThan(20);
    }
  });

  it("proposes nothing for a small change to an existing project", () => {
    expect(designStage("add a --verbose flag to the CLI", { greenfield: false }).depth).toBe(
      undefined,
    );
  });

  it("records the person's choice with what was proposed; the ledger's one reader sees it", async () => {
    const d = designStage(RECIPES, { greenfield: true });
    const proposal = d.depth ?? proposeDepthProfile(RECIPES, {});
    const out = await recordDepthChoice(
      ledger,
      { profile: "internal tool", projectId, proposal },
      OWNER,
    );
    expect(store.depthProfiles.of(projectId)).toMatchObject({
      profile: "internal tool",
      proposed: "production",
      recorded: true,
      principal: OWNER,
    });
    expect(out.requirementIds).toHaveLength(checklistRowsFor("internal tool").length);
  });
});

describe("DS-P14-2: each must-have checklist row becomes a requirement with a criterion", () => {
  it("has words for exactly the rows each profile marks must-have", () => {
    for (const profile of ["prototype", "internal tool", "production", "regulated"] as const) {
      const words = checklistWordsFor(profile);
      expect(Object.keys(words).sort()).toEqual([...checklistRowsFor(profile)].sort());
      for (const w of Object.values(words)) {
        expect(w?.title.length).toBeGreaterThan(5);
        expect(w?.criteria?.[0]?.text).toMatch(/WHEN .* THE SYSTEM SHALL/);
      }
    }
  });

  it("choosing production adds seven checklist requirements; a prototype adds none", async () => {
    const out = await recordDepthChoice(ledger, { profile: "production", projectId }, OWNER);
    expect(out.requirementIds).toHaveLength(7);
    const reqs = await store.requirements.list({ projectId });
    expect(reqs.filter((r) => r.source === "checklist")).toHaveLength(7);
    for (const r of reqs) expect(r.criteria.length).toBeGreaterThan(0);
    const other = (await store.ensureProject({ rootPath: join(dir, "p"), name: "Toy" })).id;
    const proto = await recordDepthChoice(
      ledger,
      { profile: "prototype", projectId: other },
      OWNER,
    );
    expect(proto.requirementIds).toEqual([]);
  });
});

describe("DS-P14-4: regulated selects stricter checks and claims no compliance", () => {
  it("says so when proposed and when chosen, and nothing claims compliance", async () => {
    const spec = "a patient records service for a clinic, HIPAA audited";
    const d = designStage(spec, { greenfield: true });
    expect(d.depth?.profile).toBe("regulated");
    expect(d.depth?.reason).toMatch(/stricter checks/);
    expect(d.depth?.reason).toMatch(/claims no compliance/);
    const chosen = await recordDepthChoice(ledger, { profile: "regulated", projectId }, OWNER);
    expect(chosen.lines.join(" ")).toMatch(/claims no compliance/);
    const brief = renderBrief(d, { gates: ["test"] });
    expect(brief).toMatch(/claims no compliance/);
    expect(claimsCompliance(brief)).toBe(false);
    for (const w of Object.values(checklistWordsFor("regulated"))) {
      expect(claimsCompliance(`${w?.title} ${w?.criteria?.[0]?.text}`)).toBe(false);
    }
    for (const r of await store.requirements.list({ projectId })) {
      expect(claimsCompliance(`${r.title} ${r.criteria.map((c) => c.text).join(" ")}`)).toBe(false);
    }
    expect(claimsCompliance("The service is HIPAA compliant.")).toBe(true);
    expect(claimsCompliance("It complies with GDPR.")).toBe(true);
  });
});

const hit = (name: string, features: string[]): Comparable => ({
  name,
  url: `https://github.com/example/${name}`,
  features,
});

describe("DS-P14-5, -6: comparables with their sources; common features as must-be candidates", () => {
  it("asks only short keywords about the kind of product", () => {
    expect(comparablesQuery(RECIPES)).toBe("recipe website");
    expect(comparablesQuery("a calculator")).toBe("calculator");
    expect(comparablesQuery("add a --verbose flag")).toBeUndefined();
  });

  it("lists each comparable with its source and proposes features in at least half as must-be", async () => {
    const queries: string[] = [];
    const search = async (q: string) => {
      queries.push(q);
      return [
        hit("mealie", ["recipes", "meal-planning", "shopping-list", "self-hosted"]),
        hit("tandoor", ["recipe", "meal-planning", "shopping-list", "django"]),
        hit("grocy", ["shopping-list", "inventory"]),
        hit("kitchenowl", ["meal-planning", "flutter"]),
      ];
    };
    const out = await surveyComparables(ledger, { projectId, buildSpec: RECIPES, search });
    expect(queries).toEqual(["recipe website"]);
    for (const name of ["mealie", "tandoor", "grocy", "kitchenowl"]) {
      expect(out.lines.join("\n")).toContain(`https://github.com/example/${name}`);
    }
    const candidates = await store.candidates.list({ projectId });
    const byTitle = new Map(candidates.map((c) => [c.title, c]));
    expect(byTitle.get("Meal planning")).toMatchObject({
      source: "comparable",
      kano: "must-be",
      state: "open",
      comparables: { foundIn: 3, of: 4 },
    });
    expect(byTitle.get("Shopping list")?.sources.map((s) => s.label)).toEqual([
      "mealie",
      "tandoor",
      "grocy",
    ]);
    // A feature in one comparable is not proposed; the product's own kind is not a feature.
    expect(byTitle.has("Inventory")).toBe(false);
    expect([...byTitle.keys()].some((t) => /recipe/i.test(t ?? ""))).toBe(false);
    // DS-P14-6: a candidate is not in the graph until a person accepts it.
    expect((await store.requirements.list({ projectId })).length).toBe(0);
    expect(out.candidateIds.length).toBe(2);
  });

  it("counts a feature once per comparable, and never from one comparable alone", () => {
    const one = commonFeatures([hit("a", ["tags", "tags", "search"])], "notes");
    expect(one).toEqual([]);
    const two = commonFeatures([hit("a", ["tags", "Tags"]), hit("b", ["tags"])], "notes");
    expect(two).toEqual([expect.objectContaining({ feature: "tags", foundIn: 2, of: 2 })]);
  });
});

describe("DS-P14-9: with research off, comparables are not searched and coverage is not claimed", () => {
  it("says so, searches nothing and proposes nothing", async () => {
    const out = await surveyComparables(ledger, {
      projectId,
      buildSpec: RECIPES,
      notSearched: "research is off",
    });
    const said = out.lines.join(" ");
    expect(said).toMatch(/not searched/i);
    expect(said).toMatch(/research is off/);
    expect(said).toMatch(/not complete coverage/);
    expect(out.candidateIds).toEqual([]);
    expect(await store.candidates.list({ projectId })).toEqual([]);
  });

  it("a search that fails is not searched, never nothing found", async () => {
    const out = await surveyComparables(ledger, {
      projectId,
      buildSpec: RECIPES,
      search: async () => {
        throw new Error("403 from api.github.com");
      },
    });
    expect(out.lines.join(" ")).toMatch(/not searched.*403/i);
    expect(out.lines.join(" ")).toMatch(/not complete coverage/);
  });
});

describe("DS-P14-7: the story map is walked once per named user role", () => {
  async function brief() {
    await acceptBrief(
      ledger,
      {
        projectId,
        baseline: "Recipes live in a notebook",
        slices: [
          {
            title: "Walking skeleton",
            appetite: { cards: 4 },
            requirements: [
              {
                key: "signup",
                title: "Sign up with an email address",
                criteria: [{ id: "signup.1", text: "A new person can sign up" }],
              },
              {
                key: "fav",
                title: "Save a favourite recipe",
                criteria: [{ id: "fav.1", text: "A saved favourite is listed" }],
              },
            ],
          },
        ],
      },
      OWNER,
    );
  }

  it("does nothing before the story map exists", async () => {
    const d = designStage(RECIPES, { greenfield: true });
    const out = await walkStoryMap(ledger, { projectId, design: d });
    expect(out.walks).toEqual([]);
    expect(await store.candidates.walkthroughs(projectId)).toEqual([]);
  });

  it("records each unsupported step as a candidate, and walks a role only once", async () => {
    await brief();
    const d = designStage(RECIPES, { greenfield: true });
    const out = await walkStoryMap(ledger, { projectId, design: d });
    expect(out.walks.map((w) => w.role)).toEqual(["person"]);
    const [walk] = await store.candidates.walkthroughs(projectId);
    expect(walk?.role).toBe("person");
    const texts = walk?.steps.map((s) => s.text) ?? [];
    expect(texts).toContain("A person can sign up");
    expect(texts).toContain("A person can save favourites");
    // Supported steps cite the requirement; a stuck point becomes a candidate.
    const signUp = walk?.steps.find((s) => s.text === "A person can sign up");
    expect(signUp?.requirementIds.length).toBe(1);
    const candidates = await store.candidates.list({ projectId });
    expect(candidates.length).toBe(out.walks[0]?.candidateIds.length);
    expect(candidates.map((c) => c.title)).toContain("A person can sign out");
    for (const c of candidates)
      expect(c).toMatchObject({ source: "model-proposal", state: "open" });
    // Once per role: a second pass walks nothing again.
    const again = await walkStoryMap(ledger, { projectId, design: d });
    expect(again.walks).toEqual([]);
    expect((await store.candidates.walkthroughs(projectId)).length).toBe(1);
  });

  it("walks as each named role", async () => {
    await brief();
    const d = designStage(
      "a recipe website where authors publish recipes and readers can save favourites",
      { greenfield: true },
    );
    const out = await walkStoryMap(ledger, { projectId, design: d });
    expect(out.walks.map((w) => w.role).sort()).toEqual(["author", "reader"]);
  });
});
