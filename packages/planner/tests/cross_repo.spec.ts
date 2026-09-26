import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { describe, expect, it } from "vitest";
import { splitStoriesAcrossRepos } from "../src/cross_repo.js";
import {
  type PlannedStory,
  type PlannerLedger,
  SpidrFeaturePlanner,
  persistPlan,
} from "../src/index.js";

// review-git NEW-review-git-3 RG-N3-2 (rule 5): a planned change spanning two
// repositories becomes two cards with a dependency edge, never one card with
// two worktrees. The real planner, real SQLite.

function ledger(): PlannerLedger {
  const db = new DatabaseSync(":memory:");
  initSchema(db);
  const log = new EventLog(db);
  return { log, store: new CardStore(db, log) };
}

const API = ["api/src/invoice_export.ts", "api/src/invoice_store.ts"];
const WEB = ["web/src/invoice_export_button.ts", "web/src/invoice_view.ts"];
const SPEC =
  "Add invoice export: the API serves an invoice export and the web page offers an invoice export button.";

async function plan(repos: boolean) {
  const l = ledger();
  await l.store.createCard({ id: "epic_inv", tier: "epic", title: SPEC, status: "in_progress" });
  const p = await new SpidrFeaturePlanner().decomposeSpec({
    parentId: "epic_inv",
    parentTier: "epic",
    spec: SPEC,
    codebaseMap: {
      files: [...API, ...WEB],
      ...(repos
        ? {
            repos: [
              { name: "api", files: API },
              { name: "web", files: WEB },
            ],
          }
        : {}),
    },
  });
  const r = await persistPlan(l, p, { epicId: "epic_inv" });
  return { l, p, r };
}

const repoOf = (f: string) => (f.startsWith("api/") ? "api" : "web");

describe("a cross-repository change is two cards with a dependency edge (RG-N3-2)", () => {
  it("without declared repositories a story may span both (the case being fixed)", async () => {
    const { p } = await plan(false);
    expect(p.stories.some((s) => new Set(s.card.scopeFiles.map(repoOf)).size > 1)).toBe(true);
  });

  it("splits every spanning story into one card per repository, the downstream depending on the upstream", async () => {
    const { l, p, r } = await plan(true);
    for (const s of p.stories) expect(new Set(s.card.scopeFiles.map(repoOf)).size).toBe(1);
    const web = p.stories.filter((s) => s.card.labels?.includes("repo:web"));
    const api = p.stories.filter((s) => s.card.labels?.includes("repo:api"));
    expect(web.length).toBeGreaterThan(0);
    expect(api.length).toBeGreaterThan(0);
    for (const w of web) {
      const upstream = api.find((a) => w.dependsOn.includes(a.card.id));
      expect(upstream, `${w.card.id} depends on its api part`).toBeDefined();
      expect(w.card.scopeFiles.every((f) => f.startsWith("web/"))).toBe(true);
      expect(w.card.status).toBe("backlog");
    }
    // Each part has acceptance criteria and a test of its own, in its own
    // repository, so both pass INVEST and both persist (RG-N3-2).
    // (A test in no repository stays with the originating, upstream part.)
    for (const part of [...api, ...web]) {
      expect(part.acceptanceTests.length, part.card.id).toBeGreaterThan(0);
      for (const t of part.acceptanceTests) expect(t.initiallyFailing).toBe(true);
    }
    for (const w of web) {
      for (const t of w.acceptanceTests)
        expect(t.filePath.startsWith("web/"), t.filePath).toBe(true);
      expect(w.acceptanceTests.some((t) => t.assertion.includes("web"))).toBe(true);
    }
    const rejected = r.rejected.map((x) => x.id);
    for (const part of [...api, ...web]) expect(rejected).not.toContain(part.card.id);
    const cards = await l.store.listCards();
    const persistedApi = cards.filter((c) => c.labels?.includes("repo:api"));
    const persistedWeb = cards.filter((c) => c.labels?.includes("repo:web"));
    expect(persistedApi.length).toBeGreaterThan(0);
    expect(persistedWeb.length).toBe(web.length);
    // Two persisted cards with the dependency edge between them.
    for (const w of persistedWeb) {
      expect(w.acceptanceCriteria?.length).toBeGreaterThan(0);
      const deps = l.store.getDependencies(w.id);
      expect(
        deps.some((d) => persistedApi.some((a) => a.id === d)),
        w.id,
      ).toBe(true);
    }
  });
});

// Minor 5: an acceptance test in no declared repository's file list goes to
// the part whose repository holds its path, else the originating part —
// never copied to every part.
describe("acceptance tests of a split story (minor 5)", () => {
  const story = (tests: string[]) =>
    ({
      card: { id: "s1", title: "Export", scopeFiles: [...API, ...WEB], labels: [] },
      acceptanceTests: tests.map((filePath) => ({
        filePath,
        assertion: "The invoice export is observable.",
        initiallyFailing: true,
      })),
      dependsOn: [],
      rationale: "r.",
    }) as unknown as PlannedStory;
  const repos = [
    { name: "api", files: API },
    { name: "web", files: WEB },
  ];

  it("sends a test to the repository that holds its path, else to the first part", () => {
    const parts = splitStoriesAcrossRepos(
      [story(["web/tests/button.spec.ts", "api/tests/export.spec.ts", "tests/e2e.spec.ts"])],
      repos,
    );
    const testsOf = (repo: string) =>
      parts
        .find((p) => p.card.labels?.includes(`repo:${repo}`))
        ?.acceptanceTests.map((t) => t.filePath);
    expect(testsOf("api")).toEqual(["api/tests/export.spec.ts", "tests/e2e.spec.ts"]);
    expect(testsOf("web")).toEqual(["web/tests/button.spec.ts"]);
  });

  it("writes a part with no test of its own one in its repository, scoped to its share", () => {
    const parts = splitStoriesAcrossRepos([story(["api/tests/export.spec.ts"])], repos);
    const web = parts.find((p) => p.card.labels?.includes("repo:web"));
    expect(web?.acceptanceTests).toEqual([
      {
        filePath: "web/tests/export.spec.ts",
        assertion: expect.stringContaining("the web repository's share"),
        initiallyFailing: true,
      },
    ]);
    expect(web?.acceptanceTests[0]?.assertion).toContain("web/src/invoice_export_button.ts");
    const api = parts.find((p) => p.card.labels?.includes("repo:api"));
    expect(api?.acceptanceTests.map((t) => t.filePath)).toEqual(["api/tests/export.spec.ts"]);
  });
});
