import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { MockInferenceAdapter } from "@sekhemet/models";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answer } from "../src/pm/agent.js";
import { type LibraryCandidate, formatHits, searchLibraries } from "../src/pm/libraries.js";
import {
  RESEARCH_HOSTS,
  deepPriorArtFor,
  deepQuestionDeps,
  planResearch,
} from "../src/research/plan_research.js";
import { runResearchTool } from "../src/research/researcher.js";
import {
  builtInNeed,
  priorArtLines,
  queryFor,
  reuseStack,
  reuseSurvey,
} from "../src/research/reuse.js";
import { ResearchMemory, ResearchService } from "../src/research/service.js";
import { acquireRunnerLease } from "../src/runner_lease.js";
import { type Kernel, planCommand } from "../src/wave2.js";

/**
 * Design-stage P7: the survey searches by capability, in the project's own
 * ecosystem, with one set of filters for the survey and both `find_library`
 * tools (DS-P7-4, -5, -6, -8, -9, -10). No test hands in a verdict; every
 * HTTP answer is a fixture behind the real parsing, and no request leaves.
 */

const NOW = new Date("2026-09-27T00:00:00Z");
const usage = { promptTokens: 1, completionTokens: 1, durationMs: 1 };

const lib = (name: string, extra: Partial<LibraryCandidate> = {}): LibraryCandidate => ({
  name,
  ecosystem: "npm",
  version: "1.0.0",
  license: "MIT",
  description: "Send emails with invoices attached",
  weeklyDownloads: 50_000,
  url: `https://www.npmjs.com/package/${name}`,
  ...extra,
});

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** A real TypeScript repository with a real ledger file. */
function kernel(
  files: Record<string, string> = { "src/auth.ts": "export const a = 1;\n" },
): Kernel {
  const repoPath = tempDir("sek-reuse-cap-");
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repoPath, rel)), { recursive: true });
    writeFileSync(join(repoPath, rel), text);
  }
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repoPath, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e@x");
  git("config", "user.name", "E");
  git("add", "-A");
  git("commit", "-q", "-m", "feat: init");
  mkdirSync(join(repoPath, ".sekhemet"), { recursive: true });
  const db = new DatabaseSync(join(repoPath, ".sekhemet", "events.db"));
  initSchema(db);
  const log = new EventLog(db);
  return { repoPath, log, cardStore: new CardStore(db, log) };
}

describe("DS-P7-4: popularity floors", () => {
  it("does not recommend a package with no or zero downloads and fewer than 20 stars", async () => {
    const [f] = await reuseSurvey(
      ["emails invoices"],
      {
        libraries: async () => [
          lib("no-count-mailer", { weeklyDownloads: undefined }),
          lib("zero-mailer", { weeklyDownloads: 0 }),
          lib("few-stars-mailer", { weeklyDownloads: undefined, stars: 19 }),
          lib("starred-mailer", { weeklyDownloads: undefined, stars: 20 }),
          lib("used-mailer", { weeklyDownloads: 5_000 }),
        ],
        repos: async () => [],
      },
      { now: NOW, perNeed: 10 },
    );
    expect(f?.libraries.map((l) => l.name)).toEqual(["starred-mailer", "used-mailer"]);
  });
});

describe("DS-P7-5: a Python project searches PyPI by verified name and GitHub in Python, never npm", () => {
  let root: string;
  let userConfig: string;
  beforeEach(() => {
    root = tempDir("sek-reuse-py-");
    userConfig = join(root, "user", "config.toml");
    mkdirSync(dirname(userConfig), { recursive: true });
    // A yes to the question that named pypi.org (DS-S8-8).
    writeFileSync(
      userConfig,
      `[network]\nresearch = "yes"\nresearch_hosts = [${RESEARCH_HOSTS.map((h) => `"${h}"`).join(", ")}]\n`,
    );
    vi.stubEnv("SEKHEMET_USER_CONFIG", userConfig);
    vi.stubEnv("SEKHEMET_OFFLINE", undefined as unknown as string);
  });

  /** GitHub finds two repositories; only one's PyPI project links back to it. */
  function pythonFetch() {
    const urls: string[] = [];
    const repoItem = (full: string, description: string, stars: number) => ({
      full_name: full,
      license: { spdx_id: "MIT" },
      stargazers_count: stars,
      archived: false,
      pushed_at: "2026-08-01T00:00:00Z",
      description,
      html_url: `https://github.com/${full}`,
    });
    const pypi = (name: string, source: string) => ({
      info: {
        name,
        version: "6.0.2",
        license_expression: "MIT",
        summary: "YAML parser and emitter for Python",
        project_urls: { Source: source },
      },
      urls: [{ upload_time_iso_8601: "2026-08-06T00:00:00Z" }],
    });
    const f = async (input: string | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("api.github.com/search/repositories"))
        return Response.json({
          items: [
            repoItem("yaml/pyyaml", "Canonical source repository for PyYAML, parses yaml", 2500),
            repoItem("someone/yamlfast", "parses yaml config quickly", 300),
          ],
        });
      if (url === "https://pypi.org/pypi/pyyaml/json")
        return Response.json(pypi("PyYAML", "https://github.com/yaml/pyyaml"));
      // A same-named project on PyPI that is not this repository's.
      if (url === "https://pypi.org/pypi/yamlfast/json")
        return Response.json(pypi("yamlfast", "https://github.com/elsewhere/yamlfast"));
      return new Response("not found", { status: 404 });
    };
    return { f, urls };
  }

  it("recommends the PyPI project whose own links name the repository, from one GitHub search in Python", async () => {
    const k = kernel({ "pyproject.toml": '[project]\nname = "notes"\n' });
    const { f, urls } = pythonFetch();
    const deps = await planResearch({
      repoPath: k.repoPath,
      log: k.log,
      newProject: false,
      print: () => undefined,
      fetchImpl: f,
    });
    expect(deps).toBeDefined();
    const need = "parses yaml config files";
    const [found] = await reuseSurvey([need], deps as never, {
      now: NOW,
      stack: reuseStack(k.repoPath, "typescript"),
    });
    expect(urls.some((u) => u.includes("npmjs"))).toBe(false);
    const searches = urls.filter((u) => u.includes("api.github.com/search/repositories"));
    expect(searches).toHaveLength(1);
    expect(decodeURIComponent(searches[0] as string)).toContain("language:python");
    expect(found?.libraries.map((l) => [l.name, l.ecosystem])).toEqual([["PyYAML", "pypi"]]);
    expect(found?.repos.map((r) => r.fullName)).toContain("yaml/pyyaml");
    // The recorded query holds only the need's keywords; the language is its own field.
    const events = await k.log.getEventsByTypes(["research/query"]);
    const keywords = new Set(queryFor(need).split(" "));
    const searches2 = events.filter(
      (e) => (e.payload as { source: string }).source !== "pypi-name",
    );
    expect(searches2.length).toBeGreaterThan(0);
    for (const e of searches2) {
      const p = e.private as { query: string; language?: string };
      for (const word of p.query.split(" ")) expect(keywords.has(word)).toBe(true);
      expect(p.language).toBe("python");
    }
    // DS-S8-3 (review of B4.5): each PyPI name looked up is a query sent, so
    // it is on the ledger too, and it is a name GitHub returned for the keywords.
    const lookups = events.filter((e) => (e.payload as { source: string }).source === "pypi-name");
    const looked = urls.filter((u) => u.startsWith("https://pypi.org/pypi/"));
    expect(lookups.map((e) => (e.private as { query: string }).query).sort()).toEqual(
      looked.map((u) => decodeURIComponent(u.split("/")[4] as string)).sort(),
    );
    for (const e of lookups) {
      const p = e.private as { query: string; results: string[] };
      expect(["pyyaml", "python-pyyaml", "yamlfast", "python-yamlfast"]).toContain(p.query);
    }
    expect(
      lookups.find((e) => (e.private as { query: string }).query === "pyyaml")?.private,
    ).toMatchObject({ results: ["PyYAML"] });
  });

  /** One repository on GitHub whose PyPI project states its licence by classifiers. */
  const classified = (classifiers: string[], license?: string) => async (url: string) => {
    if (url.includes("api.github.com"))
      return {
        items: [
          {
            full_name: "acme/yamlkit",
            license: { spdx_id: "NOASSERTION" },
            stargazers_count: 900,
            archived: false,
            pushed_at: "2026-08-01T00:00:00Z",
            description: "parses yaml documents",
            html_url: "https://github.com/acme/yamlkit",
          },
        ],
      };
    if (url === "https://pypi.org/pypi/yamlkit/json")
      return {
        info: {
          name: "yamlkit",
          version: "2.0",
          ...(license ? { license } : {}),
          classifiers,
          summary: "parses yaml documents",
          project_urls: { Source: "https://github.com/acme/yamlkit" },
        },
        urls: [{ upload_time_iso_8601: "2026-08-06T00:00:00Z" }],
      };
    throw new Error(`404 from ${new URL(url).host}`);
  };

  it.each([
    ["License :: OSI Approved :: Python Software Foundation License", "permissive"],
    ["License :: OSI Approved :: ISC License (ISCL)", "permissive"],
    ["License :: OSI Approved :: The Unlicense (Unlicense)", "permissive"],
    ["License :: OSI Approved :: Mozilla Public License 2.0 (MPL 2.0)", "weak_copyleft"],
    ["License :: OSI Approved :: GNU Lesser General Public License v3 (LGPLv3)", "weak_copyleft"],
  ])("reads the trove classifier %s as %s (review of B4.5)", async (classifier, verdict) => {
    const [hit] = await searchLibraries("parses yaml", "pypi", classified([classifier], "ISC"));
    expect(hit?.verdict).toBe(verdict);
  });

  it("judges every licence classifier, so Apache beside GPL is excluded and named", async () => {
    const hits = await searchLibraries(
      "parses yaml",
      "pypi",
      classified([
        "License :: OSI Approved :: Apache Software License",
        "License :: OSI Approved :: GNU General Public License v2 (GPLv2)",
      ]),
    );
    expect(hits.map((h) => [h.name, h.verdict, h.action, h.usable])).toEqual([
      ["yamlkit", "strong_copyleft", "exclude", false],
    ]);
    expect(hits[0]?.license).toBe("Apache-2.0 AND GPL-2.0-only");
  });

  it("Seshat's and the Researcher's find_library look PyPI up by verified name too", async () => {
    const { f, urls } = pythonFetch();
    const json = async (url: string) => {
      const res = await f(url);
      if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
      return res.json();
    };
    const hits = await searchLibraries("parses yaml config", "pypi", json);
    expect(hits.map((h) => h.name)).toEqual(["PyYAML"]);
    expect(urls.some((u) => u.includes("npmjs"))).toBe(false);
    // Not the first word of the query looked up as a name.
    expect(urls).not.toContain("https://pypi.org/pypi/parses/json");
  });

  it("a link to another repository that shares the name's prefix does not verify it", async () => {
    const urls: string[] = [];
    const json = async (url: string) => {
      urls.push(url);
      if (url.includes("api.github.com"))
        return {
          items: [
            {
              full_name: "yaml/pyyaml",
              license: { spdx_id: "MIT" },
              stargazers_count: 2500,
              archived: false,
              pushed_at: "2026-08-01T00:00:00Z",
              description: "parses yaml",
              html_url: "https://github.com/yaml/pyyaml",
            },
          ],
        };
      if (url === "https://pypi.org/pypi/pyyaml/json")
        return {
          info: {
            name: "pyyaml",
            version: "1.0",
            license_expression: "MIT",
            summary: "parses yaml",
            project_urls: { Source: "https://github.com/yaml/pyyaml-extra" },
          },
        };
      throw new Error(`404 from ${new URL(url).host}`);
    };
    expect(await searchLibraries("parses yaml", "pypi", json)).toEqual([]);
  });

  it("reads the project's stack from its files before the spec's words", () => {
    const py = kernel({ "requirements.txt": "requests\n" });
    expect(reuseStack(py.repoPath, "typescript")).toBe("python");
    const ts = kernel({ "package.json": "{}\n" });
    expect(reuseStack(ts.repoPath, "python")).toBe("typescript");
    const empty = tempDir("sek-empty-");
    expect(reuseStack(empty, "python")).toBe("python");
  });
});

describe('DS-P7-6: "a calculator" needs no package', () => {
  it("recommends none, sends no query, and says none is needed", async () => {
    expect(builtInNeed("a calculator")).toBe(true);
    expect(builtInNeed("emails invoices")).toBe(false);
    const calls: string[] = [];
    const dep = async (q: string) => {
      calls.push(q);
      return [];
    };
    const [f] = await reuseSurvey(["a calculator"], { libraries: dep, repos: dep, papers: dep });
    expect(calls).toEqual([]);
    expect(f?.noneNeeded).toBe(true);
    expect(f?.libraries).toEqual([]);
    expect(priorArtLines(f ? [f] : []).join("\n")).toMatch(/no package is needed/i);
  });

  it("a need about a user, names or a list of things is searched (review of B4.5)", () => {
    for (const need of ["checks the user", "user list", "random names", "greets the user by name"])
      expect(builtInNeed(need), need).toBe(false);
    for (const need of [
      "checks whether a number is prime",
      "reverses a string",
      "adds two numbers",
    ])
      expect(builtInNeed(need), need).toBe(true);
  });

  it("`plan` says so for a new calculator, and recommends nothing", async () => {
    // A new project: no source file yet, so the design stage says one sentence.
    const k = kernel({ "README.md": "# calc\n" });
    const out: string[] = [];
    const calls: string[] = [];
    await planCommand(k, "Build me a calculator", {
      print: (l) => out.push(l),
      research: {
        libraries: async (q) => {
          calls.push(q);
          return [lib("calculator", { description: "a calculator" })];
        },
        repos: async () => [],
      },
    });
    expect(calls).toEqual([]);
    expect(out.join("\n")).toMatch(/a calculator: no package is needed/i);
    expect(out.join("\n")).not.toMatch(/may already cover this/);
  });
});

describe("DS-P7-8: findings reach the card built for the need when a model rephrases titles", () => {
  it("attaches each need's findings to its card, and to no other", async () => {
    const k = kernel();
    const slice = (title: string, keywords: string[], behaviour: string) => ({
      kind: "path",
      title,
      keywords,
      rationale: "happy path",
      behaviour,
    });
    const planner = new MockInferenceAdapter("planner", [
      {
        text: JSON.stringify({
          slices: [
            slice(
              "Send invoice mail to each customer",
              ["invoice", "email"],
              "Given a paid charge, one invoice email is sent to the customer.",
            ),
            slice(
              "Give money back on request",
              ["refund"],
              "Given a 500-cent charge, a refund request returns 500 cents.",
            ),
          ],
        }),
        toolCalls: [],
        usage,
      },
    ]);
    await planCommand(
      k,
      "a billing service that charges customers monthly, handles refunds, and emails invoices",
      {
        print: () => undefined,
        sketcher: planner,
        research: {
          libraries: async (q) =>
            q.includes("invoices")
              ? [lib("nodemailer")]
              : q.includes("refunds")
                ? [lib("refund-kit", { description: "Compute and issue refunds" })]
                : [],
          repos: async () => [],
        },
      },
    );
    const cards = await k.cardStore.listCards();
    const mail = cards.find((c) => c.title === "Send invoice mail to each customer");
    const refund = cards.find((c) => c.title === "Give money back on request");
    expect(mail && refund).toBeTruthy();
    const notes = async (id: string) =>
      (await k.cardStore.getDossier(id)).notes.map((n) => n.text).join("\n");
    expect(await notes(mail?.id ?? "")).toMatch(/nodemailer/);
    expect(await notes(mail?.id ?? "")).not.toMatch(/refund-kit/);
    expect(await notes(refund?.id ?? "")).toMatch(/refund-kit/);
    expect(await notes(refund?.id ?? "")).not.toMatch(/nodemailer/);
  });
});

describe("DS-P7-9: find_library applies the survey's filters, for Seshat and the Researcher", () => {
  const candidates: LibraryCandidate[] = [
    lib("invoice-mailer"),
    // Popular and permissive, but about something else.
    lib("left-pad", { description: "Pad a string on the left" }),
    // Relevant, but almost nobody uses it.
    lib("tiny-invoice-mailer", { weeklyDownloads: undefined, stars: 3 }),
    // Relevant and used, but not published for years.
    lib("old-invoice-mailer", { publishedAt: "2019-01-01T00:00:00Z" }),
    lib("gpl-invoice-mailer", { license: "GPL-3.0-only" }),
  ];
  const shown = (text: string) =>
    [...text.matchAll(/^- (\S+)@/gm)].map((m) => m[1] as string).sort();

  it("the survey, formatHits and both tools keep the same candidates", async () => {
    const [f] = await reuseSurvey(
      ["emails invoices"],
      { libraries: async () => candidates, repos: async () => [] },
      { now: NOW, perNeed: 10 },
    );
    const surveyed = [...(f?.libraries ?? []).map((l) => l.name), ...(f?.excluded ?? [])];
    expect(f?.libraries.map((l) => l.name)).toEqual(["invoice-mailer"]);
    expect(f?.excluded).toEqual(["gpl-invoice-mailer (GPL-3.0-only)"]);
    const text = formatHits("emails invoices", candidates, NOW);
    expect(shown(text)).toEqual(["gpl-invoice-mailer", "invoice-mailer"]);
    expect(surveyed).toHaveLength(2);

    const researcher = await runResearchTool(
      { id: "1", name: "find_library", arguments: { query: "emails invoices" } },
      { repoPath: process.cwd(), libraries: async () => candidates, today: "2026-09-27" },
    );
    expect(shown(researcher.text)).toEqual(["gpl-invoice-mailer", "invoice-mailer"]);

    const db = new DatabaseSync(":memory:");
    initSchema(db);
    const cards = new CardStore(db, new EventLog(db));
    const model = new MockInferenceAdapter("dirk-27b", [
      {
        text: "",
        toolCalls: [{ id: "1", name: "find_library", arguments: { query: "emails invoices" } }],
        usage,
      },
      { text: "Use invoice-mailer.", toolCalls: [], usage },
    ]);
    await answer(
      model,
      {
        project: "p",
        cards: await cards.listCards(),
        cycles: [],
        recentRuns: [],
        pmModel: "dirk-27b",
        today: "2026-09-27",
      },
      [],
      [{ id: "m", seq: 1, role: "user", text: "Send invoices", createdAt: "", state: "queued" }],
      undefined,
      async () => candidates,
    );
    const prompt = model.callHistory[1]?.prompt ?? "";
    const lookup = prompt.slice(prompt.indexOf('find_library("emails invoices"'));
    expect(lookup).toContain("invoice-mailer@1.0.0");
    for (const dropped of ["left-pad", "tiny-invoice-mailer", "old-invoice-mailer"]) {
      expect(lookup).not.toContain(`${dropped}@`);
    }
    db.close();
  });
});

describe("DS-P7-10: a brief's Prior art has one cited deep answer, or says why not", () => {
  const BRIEF_SPEC = "a billing service that charges customers monthly";
  const brief = (k: Kernel) => readFileSync(join(k.repoPath, ".sekhemet", "brief.md"), "utf8");
  const priorArt = (text: string) => /## Prior art\n([\s\S]*?)\n## /.exec(text)?.[1] ?? "";

  it("writes the Researcher's answer with its sources when it may run", async () => {
    const k = kernel();
    const asked: string[] = [];
    await planCommand(k, BRIEF_SPEC, {
      print: () => undefined,
      deep: {
        run: async (question) => {
          asked.push(question);
          return {
            answer: "Teams usually use a hosted billing engine rather than their own scheduler.",
            sources: ["https://example.org/billing-engines"],
            grounded: true,
          };
        },
      },
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/billing/);
    const art = priorArt(brief(k));
    expect(art).toContain("hosted billing engine");
    expect(art).toContain("https://example.org/billing-engines");
  });

  it("says the deep question did not run, and why, when it may not", async () => {
    const k = kernel();
    await planCommand(k, BRIEF_SPEC, {
      print: () => undefined,
      deep: { skipped: "card c-7 is running (pid 42)" },
    });
    expect(priorArt(brief(k))).toMatch(/deep question did not run: card c-7 is running/i);
    const none = kernel();
    await planCommand(none, BRIEF_SPEC, { print: () => undefined });
    expect(priorArt(brief(none))).toMatch(/deep question did not run: no Researcher/i);
  });

  it("an answer without a citation is not written as one", async () => {
    const k = kernel();
    await planCommand(k, BRIEF_SPEC, {
      print: () => undefined,
      deep: { run: async () => ({ answer: "Probably Stripe.", sources: [], grounded: false }) },
    });
    const art = priorArt(brief(k));
    expect(art).not.toContain("Probably Stripe");
    expect(art).toMatch(/deep question ran but its answer cited no source/i);
  });

  it("asks nothing below the brief level", async () => {
    const k = kernel();
    let asked = 0;
    await planCommand(k, "add a --json flag to the export command", {
      print: () => undefined,
      deep: {
        run: async () => {
          asked++;
          return { answer: "x", sources: ["https://x.test"], grounded: true };
        },
      },
    });
    expect(asked).toBe(0);
  });

  it("decides whether it may run: offline, research off, no Researcher, a running card", async () => {
    const k = kernel();
    const ask = async () => ({ answer: "a", sources: ["s"], grounded: true });
    const reason = (o: Partial<Parameters<typeof deepPriorArtFor>[0]>) => {
      const d = deepPriorArtFor({
        repoPath: k.repoPath,
        allowed: true,
        offline: false,
        researcher: "apodex",
        ask,
        ...o,
      });
      return "skipped" in d ? d.skipped : "runs";
    };
    expect(reason({})).toBe("runs");
    expect(reason({ offline: true })).toMatch(/offline/);
    expect(reason({ allowed: false })).toMatch(/research is off/);
    expect(reason({ researcher: undefined })).toMatch(/no Researcher is configured/);
    const lease = acquireRunnerLease(k.repoPath, { kind: "run", cardId: "c-7" });
    expect("release" in lease).toBe(true);
    try {
      expect(reason({})).toMatch(/card c-7 is running/);
    } finally {
      if ("release" in lease) lease.release();
    }
    expect(reason({})).toBe("runs");
  });
});

describe("find_library's registry search goes through the research policy (review of B4.5)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("the Researcher's find_library sends nothing when research web is off", async () => {
    const global = vi.fn(async () => Response.json({ objects: [] }));
    vi.stubGlobal("fetch", global);
    for (const call of [
      { id: "1", name: "find_library", arguments: { query: "python csv", ecosystem: "pypi" } },
      { id: "2", name: "package_readme", arguments: { name: "zod" } },
    ]) {
      const r = await runResearchTool(call, { repoPath: process.cwd() });
      expect(r.text).toMatch(/needs web access, which is off/);
      expect(r.source).toBeUndefined();
    }
    expect(global).not.toHaveBeenCalled();
  });

  it("with research web on, it fetches through the web access's policy fetch, never the global one", async () => {
    const global = vi.fn(async () => Response.json({ objects: [] }));
    vi.stubGlobal("fetch", global);
    const seen: string[] = [];
    const policyFetch = async (input: string | URL) => {
      seen.push(String(input));
      return Response.json({
        objects: [
          {
            package: {
              name: "csv-parse",
              version: "5.0.0",
              description: "parse csv",
              license: "MIT",
            },
            downloads: { weekly: 5_000_000 },
          },
        ],
      });
    };
    const r = await runResearchTool(
      { id: "1", name: "find_library", arguments: { query: "parse csv" } },
      { repoPath: process.cwd(), web: { fetch: policyFetch } },
    );
    expect(r.text).toContain("csv-parse@5.0.0");
    expect(seen.some((u) => u.startsWith("https://registry.npmjs.org/-/v1/search"))).toBe(true);
    expect(global).not.toHaveBeenCalled();
  });

  it("Seshat's find_library without a search from research consent sends nothing", async () => {
    const global = vi.fn(async () => Response.json({ objects: [] }));
    vi.stubGlobal("fetch", global);
    const db = new DatabaseSync(":memory:");
    initSchema(db);
    const cards = new CardStore(db, new EventLog(db));
    const model = new MockInferenceAdapter("dirk-27b", [
      {
        text: "",
        toolCalls: [{ id: "1", name: "find_library", arguments: { query: "python csv" } }],
        usage,
      },
      { text: "No search ran.", toolCalls: [], usage },
    ]);
    await answer(
      model,
      {
        project: "p",
        cards: await cards.listCards(),
        cycles: [],
        recentRuns: [],
        pmModel: "dirk-27b",
        today: "2026-09-27",
      },
      [],
      [{ id: "m", seq: 1, role: "user", text: "csv?", createdAt: "", state: "queued" }],
    );
    expect(global).not.toHaveBeenCalled();
    expect(model.callHistory[1]?.prompt ?? "").toMatch(
      /find_library\("python csv", npm\):\n.*research/i,
    );
    db.close();
  });
});

describe("the brief's deep question reads nothing of the repository (review of B4.5, S8)", () => {
  it("refuses the repository tools, so no repository text can reach a query", async () => {
    const k = kernel({ "src/secret.ts": "export const plan = 'acme merger';\n" });
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "acme merger codename falcon"], {
      cwd: k.repoPath,
    });
    const deps = deepQuestionDeps({ repoPath: k.repoPath, fetchJson: async () => ({}) });
    expect(deps.repository).toBe(false);
    for (const call of [
      { id: "1", name: "git_history", arguments: { query: "merger" } },
      { id: "2", name: "deps_source", arguments: { name: "zod" } },
      { id: "3", name: "deps_grep", arguments: { name: "zod", pattern: "x" } },
      { id: "4", name: "module_api", arguments: { module: "node:fs" } },
    ]) {
      const r = await runResearchTool(call, { ...deps, repoPath: k.repoPath });
      expect(r.text).not.toMatch(/falcon|merger/);
      expect(r.text).toMatch(/does not read this repository/);
      expect(r.source).toBeUndefined();
    }
  });

  it("the Researcher asked it through ResearchService neither offers nor runs them", async () => {
    const k = kernel();
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "acme merger codename falcon"], {
      cwd: k.repoPath,
    });
    const model = new MockInferenceAdapter("generic", [
      {
        text: "",
        toolCalls: [{ id: "1", name: "git_history", arguments: { query: "merger" } }],
        usage,
      },
      { text: "Not settled.", toolCalls: [], usage },
    ]);
    const service = new ResearchService({
      repoPath: k.repoPath,
      memory: new ResearchMemory(join(tempDir("sek-mem-"), "m.jsonl")),
      model: async () => model,
      tools: deepQuestionDeps({ repoPath: k.repoPath, fetchJson: async () => ({}) }),
    });
    await service.ask("What do teams use for invoices?");
    const offered = (model.callHistory[0]?.tools ?? []).map((t) => t.name);
    expect(offered).toContain("find_library");
    for (const name of ["git_history", "deps_source", "deps_grep", "module_api"])
      expect(offered).not.toContain(name);
    const second = JSON.stringify(model.callHistory[1] ?? {});
    expect(second).toMatch(/does not read this repository/);
    expect(second).not.toMatch(/falcon/);
  });
});

describe("DS-P7-10: the lease is checked again when the Researcher is about to load (review of B4.5)", () => {
  it("a card started while the plan ran stops the deep question, and the brief says why", async () => {
    const k = kernel();
    let asked = 0;
    const deep = deepPriorArtFor({
      repoPath: k.repoPath,
      allowed: true,
      offline: false,
      researcher: "apodex",
      ask: async () => {
        asked++;
        return { answer: "a", sources: ["https://x.test"], grounded: true };
      },
    });
    expect("run" in deep).toBe(true);
    const lease = acquireRunnerLease(k.repoPath, { kind: "run", cardId: "c-9" });
    try {
      await planCommand(k, "a billing service that charges customers monthly", {
        print: () => undefined,
        deep,
      });
    } finally {
      if ("release" in lease) lease.release();
    }
    expect(asked).toBe(0);
    const brief = readFileSync(join(k.repoPath, ".sekhemet", "brief.md"), "utf8");
    expect(brief).toMatch(/deep question did not run: card c-9 is running/i);
    expect(brief).not.toMatch(/Researcher failed/);
  });
});
