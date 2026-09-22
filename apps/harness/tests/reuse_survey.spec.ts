import { describe, expect, it } from "vitest";
import type { LibraryHit } from "../src/pm/libraries.js";
import {
  type RepoHit,
  dossierNote,
  needsLiterature,
  priorArtLines,
  queryFor,
  reuseSurvey,
  searchRepos,
  withPriorArt,
} from "../src/research/reuse.js";
import type { Hit } from "../src/research/web.js";

/**
 * Reuse before rebuild. The complaint this answers: an agent reinvents what a
 * maintained, legally usable package or repository already does. Before a
 * spec becomes cards, the planner looks — registries, GitHub, and, where the
 * work is an algorithm, the literature — and only recommends what the
 * licence allows.
 */

// Realistic candidates describe what they do; the survey only keeps one
// whose name or description shares what the need is about.
const lib = (name: string, license: string, usable: boolean): LibraryHit => ({
  name,
  ecosystem: "npm",
  version: "1.0.0",
  license,
  usable,
  description: "Send emails with invoices attached",
  weeklyDownloads: 50000,
  url: `https://www.npmjs.com/package/${name}`,
});

const repo = (name: string, license: string, extra: Partial<RepoHit> = {}): RepoHit => ({
  fullName: `org/${name}`,
  license,
  usable: license === "MIT",
  stars: 1200,
  archived: false,
  pushedAt: "2026-06-01T00:00:00Z",
  description: "Email invoices to customers",
  url: `https://github.com/org/${name}`,
  ...extra,
});

describe("the reuse survey", () => {
  it("looks for each need in the registries and on GitHub, and keeps only what the licence allows", async () => {
    const findings = await reuseSurvey(["emails invoices"], {
      libraries: async () => [
        lib("nodemailer", "MIT-0", true),
        lib("gpl-mailer", "GPL-3.0", false),
      ],
      repos: async () => [repo("invoice-kit", "MIT"), repo("copyleft-inv", "AGPL-3.0")],
    });
    const [f] = findings;
    expect(f?.libraries.map((l) => l.name)).toEqual(["nodemailer"]);
    expect(f?.repos.map((r) => r.fullName)).toEqual(["org/invoice-kit"]);
    // What was excluded, and why, is stated rather than silently dropped.
    expect(f?.excluded).toEqual(["gpl-mailer (GPL-3.0)", "org/copyleft-inv (AGPL-3.0)"]);
  });

  it("drops candidates that only matched on a popular keyword", async () => {
    // Live, 2026-09-22: "handles refunds" returned streamx (a streams library)
    // and eslint-plugin-simple-import-sort; "deduplicates similar photos"
    // returned @graphql-inspector/cli. Each was reported as "already does
    // this". A candidate must share what the need is about, not its verbs.
    const [refunds] = await reuseSurvey(["handles refunds"], {
      libraries: async () => [
        { ...lib("streamx", "MIT", true), description: "An iteration of the Node.js core streams" },
        {
          ...lib("eslint-plugin-simple-import-sort", "MIT", true),
          description: "Easy sorting of imports",
        },
        { ...lib("refund-calc", "MIT", true), description: "Compute partial refunds for orders" },
      ],
      repos: async () => [repo("spring5webapp", "unknown")],
    });
    expect(refunds?.libraries.map((l) => l.name)).toEqual(["refund-calc"]);
    // Irrelevant results are not "excluded for their licence": they were never candidates.
    expect(refunds?.excluded).toEqual([]);
    const [photos] = await reuseSurvey(["a CLI that deduplicates similar photos in a folder"], {
      libraries: async () => [
        { ...lib("@graphql-inspector/cli", "MIT", true), description: "Tooling for GraphQL" },
        { ...lib("image-dedupe", "MIT", true), description: "Find duplicate and similar photos" },
      ],
      repos: async () => [],
    });
    expect(photos?.libraries.map((l) => l.name)).toEqual(["image-dedupe"]);
  });

  it("does not recommend what almost nobody uses, or list unlicensed noise", async () => {
    // Live, 2026-09-22: "handles refunds" recommended a test fork at 187
    // downloads a week, and the exclusions were mostly unrelated repositories
    // with no licence at all — code nobody may use, so not worth naming.
    const [f] = await reuseSurvey(["handles refunds"], {
      libraries: async () => [
        {
          ...lib("@someone_test/refunds", "MIT", true),
          description: "refunds",
          weeklyDownloads: 187,
        },
        { ...lib("refund-kit", "MIT", true), description: "refunds", weeklyDownloads: 20000 },
        { ...lib("gpl-refunds", "GPL-3.0", false), description: "refunds", weeklyDownloads: 9000 },
      ],
      repos: async () => [
        repo("tiny-refunds", "MIT", { stars: 3, description: "refunds" }),
        repo("refund-engine", "MIT", { stars: 400, description: "refunds" }),
        repo("unlicensed-refunds", "unknown", { stars: 500, description: "refunds" }),
      ],
    });
    expect(f?.libraries.map((l) => l.name)).toEqual(["refund-kit"]);
    expect(f?.repos.map((r) => r.fullName)).toEqual(["org/refund-engine"]);
    expect(f?.excluded).toEqual(["gpl-refunds (GPL-3.0)"]);
  });

  it("queries with what the need is about, not its generic words", () => {
    expect(queryFor("handles refunds")).toBe("refunds");
    expect(queryFor("a CLI that deduplicates similar photos in a folder")).toBe(
      "deduplicates similar photos",
    );
  });

  it("does not recommend an archived or abandoned repository", async () => {
    const [f] = await reuseSurvey(
      ["parses csv"],
      {
        libraries: async () => [],
        repos: async () => [
          repo("dead", "MIT", { archived: true, description: "parses csv files" }),
          repo("stale", "MIT", {
            pushedAt: "2021-01-01T00:00:00Z",
            description: "parses csv files",
          }),
          repo("alive", "MIT", { description: "parses csv files" }),
        ],
      },
      { now: new Date("2026-09-22T00:00:00Z") },
    );
    expect(f?.repos.map((r) => r.fullName)).toEqual(["org/alive"]);
  });

  it("reads the literature only when the need is an algorithm", async () => {
    expect(needsLiterature("ranks search results by relevance")).toBe(true);
    expect(needsLiterature("emails invoices")).toBe(false);
    let asked = 0;
    const papers = async (): Promise<Hit[]> => {
      asked++;
      return [
        {
          title: "Ranking search results: BM25 revisited",
          url: "https://arxiv.org/abs/1",
          snippet: "",
        },
      ];
    };
    const none = async () => [];
    await reuseSurvey(["emails invoices"], { libraries: none, repos: none, papers });
    expect(asked).toBe(0);
    const [f] = await reuseSurvey(["ranks search results"], {
      libraries: none,
      repos: none,
      papers,
    });
    expect(asked).toBe(1);
    expect(f?.papers[0]?.title).toBe("Ranking search results: BM25 revisited");
  });

  it("reports a search that could not run as not searched, never as nothing found", async () => {
    const [f] = await reuseSurvey(["emails invoices"], {
      libraries: async () => {
        throw new Error("offline");
      },
      repos: async () => [],
    });
    expect(f?.unsearched).toEqual(["registries"]);
    expect(priorArtLines(f ? [f] : []).join("\n")).toMatch(/registries: not searched/);
  });

  it("tells the Worker what to use instead of writing it, with the licence", async () => {
    const [f] = await reuseSurvey(["emails invoices"], {
      libraries: async () => [lib("nodemailer", "MIT-0", true)],
      repos: async () => [],
    });
    expect(f && dossierNote(f)).toMatch(/Before writing this yourself.*nodemailer \(MIT-0/);
    const [empty] = await reuseSurvey(["glue code"], {
      libraries: async () => [],
      repos: async () => [],
    });
    expect(empty).toBeDefined();
    expect(empty && dossierNote(empty)).toBeUndefined();
  });

  it("replaces the brief's unresearched prior-art section with what was found", () => {
    const brief =
      "## Constraints\n- x\n\n## Prior art\n- Not researched.\n\n## Riskiest assumption\n- y\n";
    const out = withPriorArt(brief, ["- **emails invoices**: nodemailer (MIT-0)"]);
    expect(out).toContain("## Prior art\n- **emails invoices**: nodemailer (MIT-0)\n\n## Riskiest");
    expect(out).not.toContain("Not researched");
  });

  it("searches GitHub repositories and gives each a licence verdict", async () => {
    const hits = await searchRepos("invoice pdf", async (url) => {
      expect(url).toContain("api.github.com/search/repositories");
      expect(url).toContain("invoice%20pdf");
      return {
        items: [
          {
            full_name: "org/invoice-kit",
            license: { spdx_id: "Apache-2.0" },
            stargazers_count: 900,
            archived: false,
            pushed_at: "2026-05-01T00:00:00Z",
            description: "PDF invoices",
            html_url: "https://github.com/org/invoice-kit",
          },
          {
            full_name: "org/nolicense",
            license: null,
            stargazers_count: 5,
            archived: false,
            pushed_at: "2026-05-01T00:00:00Z",
            description: null,
            html_url: "https://github.com/org/nolicense",
          },
        ],
      };
    });
    expect(hits.map((h) => [h.fullName, h.license, h.usable])).toEqual([
      ["org/invoice-kit", "Apache-2.0", true],
      ["org/nolicense", "unknown", false],
    ]);
  });
});
