import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/index.js";
import { RESEARCH_HOSTS, planResearch } from "../src/research/plan_research.js";
import { priorArtLines, queryFor, reuseSurvey } from "../src/research/reuse.js";
import { searchPapers } from "../src/research/web.js";

/**
 * design-stage S8 — `plan` honours offline mode and the research setting, and
 * logs its queries. A real ledger file, a real user config.toml.
 */
let root: string;
let repo: string;
let userConfig: string;
let db: DatabaseSync;
let log: EventLog;
const lines: string[] = [];
const print = (l: string) => lines.push(l);

/** A fetch that answers every research source with one relevant hit, and counts. */
function countingFetch() {
  const urls: string[] = [];
  const f = async (input: string | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("registry.npmjs.org"))
      return Response.json({
        objects: [
          {
            package: {
              name: "csv-export-kit",
              version: "1.0.0",
              description: "csv export for reports",
              license: "MIT",
              links: { npm: "https://www.npmjs.com/package/csv-export-kit" },
            },
            downloads: { weekly: 50_000 },
          },
        ],
      });
    if (url.includes("api.github.com")) return Response.json({ items: [] });
    return new Response("[]", { status: 200 });
  };
  return { f, urls };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sek-plan-research-"));
  repo = join(root, "repo");
  mkdirSync(join(repo, ".sekhemet"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  userConfig = join(root, "user", "config.toml");
  vi.stubEnv("SEKHEMET_USER_CONFIG", userConfig);
  vi.stubEnv("SEKHEMET_OFFLINE", undefined as unknown as string);
  db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
  initSchema(db);
  log = new EventLog(db);
  lines.length = 0;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.exitCode = 0;
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const writeUser = (text: string) => {
  mkdirSync(join(root, "user"), { recursive: true });
  writeFileSync(userConfig, text);
};

describe("DS-S8-1: offline, or research not yes, means no request and says so", () => {
  it("--offline plans without looking, whatever research says", async () => {
    writeUser('[network]\nresearch = "yes"\n');
    const { f, urls } = countingFetch();
    const deps = await planResearch({
      repoPath: repo,
      log,
      offline: true,
      newProject: true,
      print,
      fetchImpl: f,
    });
    expect(deps).toBeUndefined();
    expect(urls).toEqual([]);
    expect(lines.join("\n")).toMatch(/did not look.*offline/i);
  });

  it('research = "no" makes zero network requests during `sekhemet plan`, and says it did not look', async () => {
    writeUser('[network]\nresearch = "no"\n');
    const fetchSpy = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchSpy);
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      out.push(a.join(" "));
    });
    // Tests never load a model: the Planner defaults to Seshat's (PM-P1-2).
    await main(["plan", "export the reports page as csv", "--repo", repo, "--planner", "none"]);
    expect(fetchSpy).not.toHaveBeenCalled();
    const check = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
    const egress = check
      .prepare(
        "SELECT COUNT(*) AS n FROM events WHERE type IN ('harness/egress', 'research/query')",
      )
      .get() as { n: number };
    check.close();
    expect(egress.n).toBe(0);
    expect(out.join("\n")).toMatch(/did not look/i);
  });
});

describe("DS-S8-2: the first new project asks once, before any request, default no", () => {
  it("names each host a yes would allow, asks before any request, and records the answer", async () => {
    const { f, urls } = countingFetch();
    let asked = "";
    const ask = async (question: string) => {
      asked = question;
      expect(urls).toEqual([]);
      return false;
    };
    const deps = await planResearch({
      repoPath: repo,
      log,
      newProject: true,
      print,
      ask,
      fetchImpl: f,
    });
    expect(deps).toBeUndefined();
    for (const host of RESEARCH_HOSTS) expect(asked).toContain(host);
    expect(readFileSync(userConfig, "utf8")).toMatch(/\[network\]\s*\nresearch = "no"/);
    expect(urls).toEqual([]);
    expect(lines.join("\n")).toMatch(/did not look/i);
  });

  it("does not ask on a project that is not new, and does not look", async () => {
    const ask = vi.fn(async () => true);
    const deps = await planResearch({ repoPath: repo, log, newProject: false, print, ask });
    expect(ask).not.toHaveBeenCalled();
    expect(deps).toBeUndefined();
  });
});

describe("DS-S8-6: a yes is not asked again; a project can turn research off", () => {
  it("runs the survey on a later project without asking", async () => {
    writeUser('[network]\nresearch = "yes"\n');
    const ask = vi.fn(async () => false);
    const { f, urls } = countingFetch();
    const deps = await planResearch({
      repoPath: repo,
      log,
      newProject: true,
      print,
      ask,
      fetchImpl: f,
    });
    expect(ask).not.toHaveBeenCalled();
    expect(deps).toBeDefined();
    const [found] = await reuseSurvey(["export reports as csv"], deps as never);
    expect(urls.length).toBeGreaterThan(0);
    expect(found?.libraries.map((l) => l.name)).toEqual(["csv-export-kit"]);
  });

  it('makes no research request for a project whose config.toml says research = "no"', async () => {
    writeUser('[network]\nresearch = "yes"\n');
    writeFileSync(join(repo, ".sekhemet", "config.toml"), '[network]\nresearch = "no"\n');
    const { f, urls } = countingFetch();
    const deps = await planResearch({ repoPath: repo, log, newProject: true, print, fetchImpl: f });
    expect(deps).toBeUndefined();
    expect(urls).toEqual([]);
    expect(lines.join("\n")).toMatch(/this project/i);
  });
});

describe("DS-S8-3, DS-S8-4: every query is logged, and only keywords leave the machine", () => {
  it("appends research/query with the source, the query and the result names", async () => {
    writeUser('[network]\nresearch = "yes"\n');
    const { f } = countingFetch();
    const deps = await planResearch({ repoPath: repo, log, newProject: true, print, fetchImpl: f });
    const need = "export the quarterly reports as csv for my accountant";
    await reuseSurvey([need], deps as never);
    const events = await log.getEventsByTypes(["research/query"]);
    expect(events.map((e) => (e.payload as { source: string }).source).sort()).toEqual([
      "GitHub",
      "registries",
    ]);
    const keywords = new Set(queryFor(need).split(" "));
    for (const e of events) {
      const p = e.private as { query: string; results: string[] };
      for (const word of p.query.split(" ")) expect(keywords.has(word)).toBe(true);
      expect(e.payload).toMatchObject({ ok: true });
    }
    const npm = events.find((e) => (e.payload as { source: string }).source === "registries");
    expect((npm?.private as { results: string[] }).results).toEqual(["csv-export-kit"]);
  });

  it("sends no query for a need with no keyword left", async () => {
    const calls: string[] = [];
    const dep = async (q: string) => {
      calls.push(q);
      return [];
    };
    const [f] = await reuseSurvey(["a simple new tool for it"], {
      libraries: dep,
      repos: dep,
      papers: dep,
    });
    expect(calls).toEqual([]);
    expect(f).toBeUndefined();
  });
});

describe("DS-S8-5: a papers outage is not searched, never nothing found", () => {
  it("throws when no paper index answers, so the survey reports literature as unreachable", async () => {
    const down = async () => {
      throw new Error("ENOTFOUND");
    };
    await expect(searchPapers("rank search results", { fetch: down })).rejects.toThrow(
      /unreachable/,
    );
    const [f] = await reuseSurvey(["ranks search results"], {
      libraries: async () => [],
      repos: async () => [],
      papers: (q) => searchPapers(q, { fetch: down }),
    });
    expect(f?.unsearched).toContain("literature");
    expect(priorArtLines(f ? [f] : []).join("\n")).toMatch(
      /literature: not searched \(unreachable\)/,
    );
  });

  it("an index that answers with nothing is nothing found", async () => {
    const empty = async () => new Response("[]", { status: 200 });
    await expect(searchPapers("rank search results", { fetch: empty })).resolves.toEqual([]);
  });
});
