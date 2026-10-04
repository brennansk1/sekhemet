import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { planResearch } from "../src/research/plan_research.js";
import { priorArtLines, reuseSurvey } from "../src/research/reuse.js";
import { RESEARCH_HOSTS, UNLISTED_YES_HOSTS } from "../src/research_consent.js";

/**
 * DEC-44 and REUSE_SURVEY_2026-09 (compliance C3): in research mode the
 * survey asks deps.dev for each candidate's release date, SPDX licences and
 * advisories, through the one network policy, and feeds them to the
 * maintenance floor, the one licence classifier and an advisory floor.
 * deps.dev is a research host, so a yes that did not name it does not reach
 * it (DS-S8-8). Every answer comes from a real HTTP server on 127.0.0.1;
 * requests to the public hosts are redirected to it, and nothing leaves.
 */

/**
 * The product's research fetch sends through `policyFetch` (node:http, not
 * the global fetch), so a stubbed global fetch never saw it and the survey
 * asked the real npm registry: its result, and this file's verdict, followed
 * the public internet. While `net.to` is set, each request the policy allows
 * is sent, still through the real `policyFetch`, to the local server under
 * its host's name; a refused one goes to the real `policyFetch` as it is, to
 * be refused and recorded there.
 */
const net = vi.hoisted(() => ({
  to: undefined as string | undefined,
  seen: [] as string[],
}));
vi.mock("@sekhemet/sandbox", async (importOriginal) => {
  const real = await importOriginal<typeof import("@sekhemet/sandbox")>();
  const policyFetch: typeof real.policyFetch = (policy, options) => {
    const send = real.policyFetch(policy, options);
    return (input, init) => {
      const u = new URL(String(input));
      if (net.to === undefined) return send(input, init);
      net.seen.push(u.hostname);
      if (real.policyRefusal(policy, u.hostname, options)) return send(input, init);
      return send(`${net.to}/${u.hostname}${u.pathname}${u.search}`, init);
    };
  };
  return { ...real, policyFetch };
});

const NOW = new Date("2026-09-27T00:00:00Z");

let server: Server;
let base: string;
let root: string;
let repo: string;
let userConfig: string;
let db: DatabaseSync;
let log: EventLog;
const hits: string[] = [];
const lines: string[] = [];
const print = (l: string) => lines.push(l);

/** What the fake deps.dev knows, by npm package name. */
const DEPS_DEV: Record<string, unknown> = {
  "mailer-gpl": {
    versionKey: { system: "NPM", name: "mailer-gpl", version: "2.0.0" },
    publishedAt: "2026-05-01T00:00:00Z",
    licenses: ["GPL-3.0-only"],
    advisoryKeys: [],
  },
  "mailer-stale": {
    versionKey: { system: "NPM", name: "mailer-stale", version: "2.0.0" },
    publishedAt: "2020-01-01T00:00:00Z",
    licenses: ["MIT"],
    advisoryKeys: [],
  },
  "mailer-advised": {
    versionKey: { system: "NPM", name: "mailer-advised", version: "2.0.0" },
    publishedAt: "2026-05-01T00:00:00Z",
    licenses: ["MIT"],
    advisoryKeys: [{ id: "GHSA-aaaa-bbbb-cccc" }],
  },
  "mailer-good": {
    versionKey: { system: "NPM", name: "mailer-good", version: "2.0.0" },
    publishedAt: "2026-05-01T00:00:00Z",
    licenses: ["MIT", "Apache-2.0"],
    advisoryKeys: [],
  },
};

/** Every candidate says MIT, recent, on the registry; deps.dev knows better. */
const NPM_OBJECTS = [
  "mailer-gpl",
  "mailer-stale",
  "mailer-advised",
  "mailer-good",
  "mailer-new",
].map((name, i) => ({
  package: {
    name,
    version: "2.0.0",
    description: "Send email over SMTP",
    license: "MIT",
    date: "2026-06-01T00:00:00Z",
  },
  downloads: { weekly: 900_000 - i * 100_000 },
}));

beforeEach(async () => {
  hits.length = 0;
  lines.length = 0;
  server = createServer((req, res) => {
    const url = req.url ?? "";
    hits.push(url);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.startsWith("/registry.npmjs.org/-/v1/search"))
      return json(200, { objects: NPM_OBJECTS });
    if (url.startsWith("/api.github.com/")) return json(200, { items: [] });
    const dd = /^\/api\.deps\.dev\/v3\/systems\/npm\/packages\/([^/]+)\/versions\/([^/]+)$/.exec(
      url,
    );
    if (dd) {
      const known = DEPS_DEV[decodeURIComponent(dd[1] ?? "")];
      return known ? json(200, known) : json(404, { code: 5, message: "not found" });
    }
    return json(200, []);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  root = mkdtempSync(join(tmpdir(), "sek-deps-dev-"));
  repo = join(root, "repo");
  mkdirSync(join(repo, ".sekhemet"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  userConfig = join(root, "user", "config.toml");
  vi.stubEnv("SEKHEMET_USER_CONFIG", userConfig);
  vi.stubEnv("SEKHEMET_OFFLINE", undefined as unknown as string);
  db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
  initSchema(db);
  log = new EventLog(db);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  db.close();
  rmSync(root, { recursive: true, force: true });
  await new Promise<void>((r) => server.close(() => r()));
});

/** The public URL, sent to the local server under its host's name. */
const local = (input: string | URL, init?: RequestInit) => {
  const u = new URL(String(input));
  return fetch(`${base}/${u.hostname}${u.pathname}${u.search}`, init);
};

const writeUser = (text: string) => {
  mkdirSync(dirname(userConfig), { recursive: true });
  writeFileSync(userConfig, text);
};
const listed = (hosts: readonly string[]) => `[${hosts.map((h) => `"${h}"`).join(", ")}]`;

async function surveyWith(hostsLine: string) {
  writeUser(`[network]\nresearch = "yes"\n${hostsLine}`);
  const deps = await planResearch({
    repoPath: repo,
    log,
    newProject: false,
    print,
    fetchImpl: local,
  });
  expect(deps).toBeDefined();
  const [f] = await reuseSurvey(["sends email over smtp"], deps as never, {
    now: NOW,
    perNeed: 10,
  });
  return f;
}

describe("deps.dev feeds the survey's floors (DEC-44)", () => {
  it("its licences go to the classifier, its release date to the maintenance floor, its advisories to their own", async () => {
    const f = await surveyWith(`research_hosts = ${listed(RESEARCH_HOSTS)}\n`);
    // deps.dev's GPL, not the registry's MIT: excluded and named.
    expect(f?.excluded).toEqual(["mailer-gpl (GPL-3.0-only)"]);
    // Released in 2020 by deps.dev's record: not maintained, not recommended.
    // Advised: usable and maintained, named with its advisory, not recommended.
    expect(f?.advised).toEqual(["mailer-advised (GHSA-aaaa-bbbb-cccc)"]);
    // Two licences found: usable only if both are. deps.dev does not know
    // mailer-new (404): the registry's facts stand.
    expect(f?.libraries.map((l) => [l.name, l.license])).toEqual([
      ["mailer-good", "MIT AND Apache-2.0"],
      ["mailer-new", "MIT"],
    ]);
    expect(f?.depsDevNotChecked).toBeUndefined();
    const text = priorArtLines(f ? [f] : []).join("\n");
    expect(text).toMatch(
      /known security advisories on the latest version: mailer-advised \(GHSA-aaaa-bbbb-cccc\)/,
    );
    // One request per candidate, each recorded as a research/query with the name only.
    expect(hits.filter((h) => h.startsWith("/api.deps.dev/"))).toHaveLength(5);
    const queries = (await log.getEventsByTypes(["research/query"]))
      .filter((e) => (e.payload as { source?: string }).source === "deps.dev")
      .map((e) => (e.private as { query?: string }).query);
    expect(queries.sort()).toEqual([
      "mailer-advised",
      "mailer-good",
      "mailer-gpl",
      "mailer-new",
      "mailer-stale",
    ]);
  });

  it("a yes that did not name api.deps.dev sends it nothing, says so, and the survey still runs", async () => {
    const f = await surveyWith(
      `research_hosts = ${listed(RESEARCH_HOSTS.filter((h) => h !== "api.deps.dev"))}\n`,
    );
    expect(hits.some((h) => h.startsWith("/api.deps.dev/"))).toBe(false);
    expect(lines.join("\n")).toMatch(/api\.deps\.dev.*awaits a yes/);
    expect(f?.unsearched).toEqual([]);
    expect(f?.depsDevNotChecked).toMatch(/api\.deps\.dev awaits a yes/);
    // The registry's facts stand: every candidate MIT and recent.
    expect(f?.libraries.map((l) => l.name)).toEqual([
      "mailer-gpl",
      "mailer-stale",
      "mailer-advised",
      "mailer-good",
      "mailer-new",
    ]);
    expect(priorArtLines(f ? [f] : []).join("\n")).toMatch(
      /release dates, licences and advisories not checked on deps\.dev: api\.deps\.dev awaits a yes/,
    );
  });

  it("an old yes without a list does not cover deps.dev; the next new project asks once, naming it", async () => {
    expect(UNLISTED_YES_HOSTS).not.toContain("api.deps.dev");
    writeUser(
      `[network]\nresearch = "yes"\nresearch_hosts = ${listed(RESEARCH_HOSTS.filter((h) => h !== "api.deps.dev"))}\n`,
    );
    const questions: string[] = [];
    const deps = await planResearch({
      repoPath: repo,
      log,
      newProject: true,
      print,
      ask: async (q) => {
        questions.push(q);
        return true;
      },
      fetchImpl: local,
    });
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain("api.deps.dev");
    expect(questions[0]).not.toContain("registry.npmjs.org");
    expect(readFileSync(userConfig, "utf8")).toMatch(/research_hosts = \[[^\]]*"api\.deps\.dev"/);
    const [f] = await reuseSurvey(["sends email over smtp"], deps as never, { now: NOW });
    expect(f?.depsDevNotChecked).toBeUndefined();
    expect(hits.some((h) => h.startsWith("/api.deps.dev/"))).toBe(true);
  });

  it("through the product's research fetch, an uncovered deps.dev is refused before sending", async () => {
    writeUser(
      `[network]\nresearch = "yes"\nresearch_hosts = ${listed(RESEARCH_HOSTS.filter((h) => h !== "api.deps.dev"))}\n`,
    );
    // No fetch handed in: the survey uses researchFetch, whose requests the
    // local server answers (net.to) and which must never send to deps.dev.
    net.seen.length = 0;
    net.to = base;
    const seen = net.seen;
    try {
      const deps = await planResearch({ repoPath: repo, log, newProject: false, print });
      const [f] = await reuseSurvey(["sends email over smtp"], deps as never, { now: NOW });
      // The registries were asked, here and nowhere else: the survey's result
      // depends on no public host (the gate failed when npm answered otherwise).
      expect(seen).toContain("registry.npmjs.org");
      expect(hits.some((h) => h.startsWith("/registry.npmjs.org/"))).toBe(true);
      expect(seen).not.toContain("api.deps.dev");
      expect(f?.depsDevNotChecked).toMatch(/^api\.deps\.dev awaits a yes/);
      expect(f?.libraries.length).toBeGreaterThan(0);
    } finally {
      net.to = undefined;
    }
  });

  it("deps.dev unreachable: the registry's facts stand and Prior art says it was not checked", async () => {
    writeUser(`[network]\nresearch = "yes"\nresearch_hosts = ${listed(RESEARCH_HOSTS)}\n`);
    const down = (input: string | URL, init?: RequestInit) =>
      new URL(String(input)).hostname === "api.deps.dev"
        ? Promise.reject(new Error("ECONNREFUSED"))
        : local(input, init);
    const deps = await planResearch({
      repoPath: repo,
      log,
      newProject: false,
      print,
      fetchImpl: down,
    });
    const [f] = await reuseSurvey(["sends email over smtp"], deps as never, {
      now: NOW,
      perNeed: 10,
    });
    expect(f?.unsearched).toEqual([]);
    expect(f?.depsDevNotChecked).toBe("unreachable");
    expect(f?.libraries).toHaveLength(5);
  });
});
