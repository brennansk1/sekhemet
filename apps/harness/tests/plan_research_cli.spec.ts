import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registryFixture } from "./reuse_registry_fixture.js";
import { type LedgerRow, cli, g2Dirs, g2Env, ledgerRows, pathWithoutGh } from "./support/g2_cli.js";
import { SCRIPTED_MODEL, scriptEnv, scriptedModel } from "./support/g2_model.js";
import { g2Project } from "./support/g2_project.js";
import { type StubPage, type WebStub, webStub } from "./support/g2_web.js";

/**
 * The reuse survey through `sekhemet plan` (design-stage §2.5 and S8,
 * DS-S8-1, DS-S8-3, DS-S8-4, DS-S8-5, DS-S8-7, DS-S8-8, DS-P7-1 to DS-P7-6,
 * DS-P7-8; FINISH_LINE_PLAN C2d): the built binary spawned in a real
 * repository, the person's `config.toml` a real file, and every registry,
 * GitHub and paper index a local stub the spawned process is routed to —
 * through `fetch` and through the network policy's own transport — so no
 * request leaves the machine. Planned without a model unless a test names
 * the scripted Planning model.
 *
 * The binary under test is `apps/harness/dist/index.js`, spawned by
 * `support/g2_cli.ts`.
 */

const ALL_HOSTS =
  '["registry.npmjs.org", "pypi.org", "api.github.com", "huggingface.co", "export.arxiv.org", "api.openalex.org", "api.deps.dev"]';

const npmPkg = (
  name: string,
  license: string | undefined,
  weekly: number,
  description?: string,
) => ({
  package: {
    name,
    version: "1.0.0",
    description: description ?? `email address validation ${name}`,
    keywords: ["email", "validation"],
    ...(license ? { license } : {}),
    date: "2025-09-01",
    links: { npm: `https://www.npmjs.com/package/${name}` },
  },
  downloads: { weekly, monthly: weekly * 4 },
});
const json = (body: unknown): StubPage => ({
  type: "application/json",
  body: JSON.stringify(body),
});
const NO_REPOS = json({ total_count: 0, items: [] });

interface Planned {
  stdout: string;
  stderr: string;
  status: number | null;
  repo: string;
  stub: WebStub;
  rows: LedgerRow[];
}

/** `sekhemet plan <spec>` in a fresh repository (a package.json: a TypeScript project). */
async function plan(
  spec: string,
  opts: {
    user?: string;
    project?: string;
    pages?: Record<string, StubPage | ((q: URLSearchParams) => StubPage)>;
    fallback?: (u: URL) => Promise<Response>;
    files?: Record<string, string>;
    args?: string[];
  } = {},
): Promise<Planned> {
  const where = g2Dirs();
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: where.cwd });
  for (const [rel, text] of Object.entries(
    opts.files ?? { "package.json": JSON.stringify({ name: "app", version: "0.1.0" }) },
  ))
    writeFileSync(join(where.cwd, rel), text);
  const stub = await webStub(opts.pages ?? {}, opts.fallback);
  const user = join(where.home, "config.toml");
  writeFileSync(user, opts.user ?? `[network]\nresearch = "yes"\nresearch_hosts = ${ALL_HOSTS}\n`);
  if (opts.project) {
    execFileSync("mkdir", ["-p", join(where.cwd, ".sekhemet")]);
    writeFileSync(join(where.cwd, ".sekhemet", "config.toml"), opts.project);
  }
  const { preload } = scriptedModel(where.home);
  const r = await cli(["plan", spec, ...(opts.args ?? ["--planner", "none"])], {
    cwd: where.cwd,
    preload,
    env: {
      ...g2Env(where.home),
      SEKHEMET_USER_CONFIG: user,
      G2_STUB_PORT: String(stub.port),
      PATH: pathWithoutGh(where.home),
    },
    timeoutMs: 120_000,
  });
  return { ...r, repo: where.cwd, stub, rows: ledgerRows(where.cwd) };
}

const queries = (rows: LedgerRow[]) =>
  rows
    .filter((r) => r.type === "research/query")
    .map(
      (r) =>
        ({ ...r.payload, ...(r.private ?? {}) }) as {
          source: string;
          query: string;
          results: string[];
          origin?: string;
          language?: string;
          ok: boolean;
        },
    );

describe("sekhemet plan: no research, no request (DS-S8-1)", () => {
  it("DS-S8-1, DS-S8-6: with research not yes, under --offline, or with the project's own configuration turning it off, plan sends nothing and says it did not look", async () => {
    const cases = [
      { user: '[network]\nmode = "open"\n' },
      { args: ["--planner", "none", "--offline"] },
      { project: '[network]\nresearch = "no"\n' },
    ];
    for (const c of cases) {
      const r = await plan("A command-line tool that validates email addresses", c);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stub.requests).toEqual([]);
      expect(r.stdout).toMatch(/Did not look for existing packages, repositories or papers/);
      expect(
        r.rows.filter((x) => x.type === "harness/egress" && x.payload.allowed === true),
      ).toEqual([]);
    }
  }, 240_000);

  it("DS-S8-1, DS-6: with research yes, mode offline and no fetch_allow, research still reaches a public host not denied, and its candidate may already cover the need", async () => {
    const r = await plan("A command-line tool that validates email addresses", {
      user: `[network]\nmode = "offline"\nresearch = "yes"\nresearch_hosts = ${ALL_HOSTS}\n`,
      pages: {
        "registry.npmjs.org/-/v1/search": () =>
          json({ objects: [npmPkg("mail-mit0", "MIT-0", 900_000)] }),
        "api.github.com/search/repositories": NO_REPOS,
      },
    });
    expect(r.stub.requests.some((x) => x.startsWith("registry.npmjs.org/-/v1/search"))).toBe(true);
    // DS-6: a candidate is said as something that may already cover the need.
    expect(r.stdout).toMatch(/mail-mit0 \(MIT-0\) may already cover this/);
  }, 120_000);
});

describe("sekhemet plan: the survey's queries, licences and outages", () => {
  const pages = {
    "registry.npmjs.org/-/v1/search": () =>
      json({
        objects: [
          npmPkg("mail-mit0", "MIT-0", 900_000),
          npmPkg("mail-lgpl", "LGPL-3.0-or-later", 950_000),
          npmPkg("mail-gpl", "GPL-3.0-only", 930_000),
          npmPkg("mail-nolicence", undefined, 910_000),
          npmPkg("mail-unused", "MIT", 0),
        ],
      }),
    "api.github.com/search/repositories": NO_REPOS,
    "export.arxiv.org/api/query": { status: 503, body: "down" },
    "api.openalex.org/works": { status: 503, body: "down" },
    "huggingface.co/api/papers/search": { status: 503, body: "down" },
  };
  const SPEC =
    "A recipe site where people sign up, validate email addresses, and recommend similar recipes";

  it("DS-S8-3, DS-S8-5, DS-P7-1, DS-P7-2, DS-P7-3, DS-P7-4: each query recorded with its source, words, results and origin; licences judged by the product's classifier; an unreachable paper index said as not searched", async () => {
    const r = await plan(SPEC, { pages });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    // DS-S8-3: every query a `research/query`: source, text, result names,
    // who wrote it; its words all the need's own.
    const sent = queries(r.rows);
    const needs = [
      "A recipe site where people sign up",
      "validate email addresses",
      "recommend similar recipes",
    ];
    const keyword = sent.filter((q) => q.origin === "keywords");
    expect(keyword.length).toBeGreaterThan(0);
    for (const q of keyword) {
      const need = needs.find((n) => q.query.split(" ").every((w) => n.toLowerCase().includes(w)));
      expect({ query: q.query, inNeed: need !== undefined }).toEqual({
        query: q.query,
        inNeed: true,
      });
    }
    const emailQuery = sent.find(
      (q) => q.source === "registries" && q.query === "validate email addresses",
    );
    expect(emailQuery?.results).toEqual([
      "mail-mit0",
      "mail-lgpl",
      "mail-gpl",
      "mail-nolicence",
      "mail-unused",
    ]);
    // A registry lookup by a returned name is a query too, with that name.
    expect(sent.filter((q) => q.source === "deps.dev").map((q) => q.query)).toEqual(
      expect.arrayContaining(["mail-mit0"]),
    );

    const brief = readFileSync(join(r.repo, ".sekhemet", "brief.md"), "utf8");
    const prior = brief.slice(brief.indexOf("## Prior art"), brief.indexOf("## Riskiest"));
    // DS-P7-1, DS-P7-3: MIT-0 judged permissive by the product's classifier
    // from the registry's licence string alone, and recommended.
    expect(prior).toMatch(/packages: mail-mit0 \(MIT-0, 900,000\/week\)/);
    // DS-P7-2: weak copyleft flagged; strong copyleft excluded and named; no licence dropped silently.
    expect(prior).toMatch(
      /weak copyleft, check with the team before depending on it: mail-lgpl \(LGPL-3\.0-or-later\)/,
    );
    expect(prior).toMatch(/excluded for their licence: mail-gpl \(GPL-3\.0-only\)/);
    expect(prior).not.toMatch(/mail-nolicence/);
    // DS-P7-4: no downloads and no stars: not recommended.
    expect(prior).not.toMatch(/mail-unused/);
    expect(r.stdout).not.toMatch(/mail-(lgpl|gpl|nolicence|unused)/);

    // DS-S8-5: the paper index errored: "not searched (unreachable)", never "nothing found".
    expect(prior).toMatch(
      /\*\*recommend similar recipes\*\*\n {2}- literature: not searched \(unreachable\)/,
    );
    expect(r.stdout).toContain(
      "I could not reach literature, so I have not checked whether this already exists there.",
    );
    expect(sent.find((q) => q.source === "literature")).toMatchObject({ ok: false });
  }, 120_000);

  it("DS-S8-4, DS-P7-6: a need with no keyword left sends no query; a need the language covers is not searched, and is said to need no package", async () => {
    const r = await plan(
      "A CLI that validates email addresses, a tool that handles files, and a calculator",
      { pages },
    );
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const sent = queries(r.rows).filter(
      (q) => q.source !== "deps.dev" && q.source !== "comparables",
    );
    expect(sent.length).toBeGreaterThan(0);
    // Only the email need was searched: "a tool that handles files" has no
    // keyword left, and the calculator is the standard library's.
    expect([...new Set(sent.map((q) => q.query))]).toEqual(["validates email addresses"]);
    expect(r.stub.requests.some((x) => /calculator|handles|files/.test(x))).toBe(false);
    expect(r.stdout).toMatch(
      /a calculator: no package is needed: the language's standard library covers this, so nothing was searched\./,
    );
  }, 120_000);
});

describe("sekhemet plan: the survey in the project's own ecosystem (DS-P7-5)", () => {
  it("DS-P7-5: a Python project searches GitHub in Python and PyPI by the verified name, and never npm", async () => {
    const reg = registryFixture();
    const r = await plan("An HTTP client", {
      files: { "pyproject.toml": '[project]\nname = "app"\nversion = "0.1.0"\n' },
      fallback: (u) => reg.fetchImpl(u),
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stub.requests.some((x) => x.startsWith("registry.npmjs.org"))).toBe(false);
    const github = r.stub.requests.filter((x) =>
      x.startsWith("api.github.com/search/repositories"),
    );
    expect(github.length).toBeGreaterThan(0);
    for (const g of github.filter((x) => !x.includes("per_page=10"))) {
      expect(decodeURIComponent(g)).toMatch(/language:python/);
    }
    // PyPI is asked by name, for names the GitHub search returned.
    expect(r.stub.requests.some((x) => /^pypi\.org\/pypi\/[^/]+\/json/.test(x))).toBe(true);
    const sent = queries(r.rows);
    expect(sent.filter((q) => q.source === "GitHub").every((q) => q.language === "python")).toBe(
      true,
    );
    expect(r.stdout).toMatch(/may already cover this — https:\/\/pypi\.org\/project\//);
  }, 120_000);
});

describe("sekhemet plan: hosts the person allowed (DS-S8-7, DS-S8-8)", () => {
  const pages = {
    "registry.npmjs.org/-/v1/search": () =>
      json({ objects: [npmPkg("mail-mit0", "MIT-0", 900_000)] }),
    "api.github.com/search/repositories": NO_REPOS,
  };

  it("DS-S8-7: with research yes and a fetch_allow list, research reads only those hosts, refusing and logging any other, whatever mode says", async () => {
    const r = await plan("A command-line tool that validates email addresses", {
      user: `[network]\nmode = "open"\nresearch = "yes"\nresearch_hosts = ${ALL_HOSTS}\nfetch_allow = ["registry.npmjs.org"]\n`,
      pages,
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const hosts = [...new Set(r.stub.requests.map((x) => x.split("/")[0]))];
    expect(hosts).toEqual(["registry.npmjs.org"]);
    const refused = r.rows
      .filter((x) => x.type === "harness/egress" && x.payload.allowed === false)
      .map((x) => x.payload as { host: string; reason: string });
    expect(refused.map((x) => x.host)).toContain("api.github.com");
    expect(refused.find((x) => x.host === "api.github.com")?.reason).toMatch(/fetch_allow/);
  }, 120_000);

  it("DS-S8-8: a yes that covers only some research hosts reaches those alone, and says which await a yes", async () => {
    const r = await plan("A command-line tool that validates email addresses", {
      user: '[network]\nresearch = "yes"\nresearch_hosts = ["registry.npmjs.org"]\n',
      pages,
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(
      /Research does not reach pypi\.org, api\.github\.com, huggingface\.co, export\.arxiv\.org, api\.openalex\.org, api\.deps\.dev: they await a yes/,
    );
    const hosts = [...new Set(r.stub.requests.map((x) => x.split("/")[0]))];
    expect(hosts).toEqual(["registry.npmjs.org"]);
    const refused = r.rows
      .filter((x) => x.type === "harness/egress" && x.payload.allowed === false)
      .map((x) => x.payload as { host: string; reason: string });
    expect(refused.find((x) => x.host === "api.github.com")?.reason).toMatch(/awaits a yes/);
  }, 120_000);
});

describe("sekhemet plan with a Planning model: findings reach the card built for the need (DS-P7-8)", () => {
  it("DS-P7-8: when the Planning model rephrases the card titles, each need's findings still reach its own card and no other", async () => {
    const where = g2Dirs();
    const p = await g2Project(where, {
      files: { "package.json": JSON.stringify({ name: "app", version: "0.1.0" }) },
      cards: [],
      qualifyAs: [{}, { role: "planner" }],
    });
    const stub = await webStub({
      "registry.npmjs.org/-/v1/search": (q) =>
        json({
          objects: (q.get("text") ?? "").includes("invoices")
            ? [npmPkg("nodemailer", "MIT-0", 6_000_000, "Send emails and invoices from Node.js")]
            : (q.get("text") ?? "").includes("refunds")
              ? [npmPkg("refund-kit", "MIT", 500_000, "Compute and issue refunds")]
              : [],
        }),
      "api.github.com/search/repositories": NO_REPOS,
    });
    const user = join(where.home, "config.toml");
    writeFileSync(user, `[network]\nresearch = "yes"\nresearch_hosts = ${ALL_HOSTS}\n`);
    const slice = (title: string, keywords: string[], behaviour: string) => ({
      kind: "path",
      title,
      keywords,
      rationale: "happy path",
      behaviour,
    });
    const slices = JSON.stringify({
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
    });
    const r = await cli(
      [
        "plan",
        "a billing service that charges customers monthly, handles refunds, and emails invoices",
        "--planner",
        SCRIPTED_MODEL,
      ],
      {
        cwd: p.repo,
        preload: p.preload,
        env: {
          ...p.env,
          SEKHEMET_USER_CONFIG: user,
          G2_STUB_PORT: String(stub.port),
          PATH: pathWithoutGh(p.home),
          ...scriptEnv(p.record, { other: slices }),
        },
        timeoutMs: 120_000,
      },
    );
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const rows = ledgerRows(p.repo);
    const card = (title: string) =>
      rows.find((x) => x.type === "card/created" && x.payload.title === title)?.payload
        .id as string;
    const notes = (id: string) =>
      rows
        .filter((x) => x.type === "card/note" && x.cardId === id)
        .map((x) => String(x.payload.text))
        .join("\n");
    const mail = card("Send invoice mail to each customer");
    const refund = card("Give money back on request");
    expect(mail && refund, r.stdout).toBeTruthy();
    expect(notes(mail)).toMatch(/nodemailer/);
    expect(notes(mail)).not.toMatch(/refund-kit/);
    expect(notes(refund)).toMatch(/refund-kit/);
    expect(notes(refund)).not.toMatch(/nodemailer/);
  }, 120_000);
});
