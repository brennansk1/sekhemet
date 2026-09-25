import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventLog, initSchema } from "@sekhemet/kernel";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PageCrawler } from "../src/research/crawl4ai.js";
import { researchSources } from "../src/research/service.js";
import { fetchPage, githubSearch } from "../src/research/web.js";

/**
 * NEW-security-8 (security item 29a, SEC-52a, SEC-52b): the requests research
 * cannot send through `fetch` — a `gh` call, a page Crawl4AI's browser reads —
 * pass the same network policy first and are logged on the ledger; a browser,
 * whose own sub-requests the policy cannot see, runs only where the policy
 * refuses no public host. No connection is made: `gh` and the crawler are fakes.
 */
const crawlHome = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const home = mkdtempSync(join(tmpdir(), "crawl-home-"));
  process.env.SEKHEMET_CRAWL4AI_HOME = home;
  return home;
});

const dirs: string[] = [];
let userConfig: string;
let repo: string;
let log: EventLog;
let db: DatabaseSync;

beforeEach(() => {
  // Crawl4AI "installed": its venv's python exists.
  mkdirSync(join(crawlHome, ".venv", "bin"), { recursive: true });
  writeFileSync(join(crawlHome, ".venv", "bin", "python"), "");
  const home = mkdtempSync(join(tmpdir(), "research-gate-home-"));
  dirs.push(home);
  userConfig = join(home, "config.toml");
  vi.stubEnv("SEKHEMET_USER_CONFIG", userConfig);
  vi.stubEnv("SEKHEMET_CRAWL4AI", "on");
  // Never the person's research cache: a page cached there would skip the crawl.
  vi.stubEnv("SEKHEMET_RESEARCH_CACHE", join(home, "cache"));
  repo = mkdtempSync(join(tmpdir(), "research-gate-repo-"));
  dirs.push(repo);
  mkdirSync(join(repo, ".sekhemet"), { recursive: true });
  db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
  initSchema(db);
  log = new EventLog(db);
});
afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
afterAll(() => rmSync(crawlHome, { recursive: true, force: true }));

const user = (lines: string) => writeFileSync(userConfig, `[network]\n${lines}\n`);
const egress = async () =>
  (await log.getEventsByTypes(["harness/egress"])).map(
    (e) => e.payload as { host: string; allowed: boolean; reason?: string; purpose: string },
  );

describe("NEW-security-8: gh and Crawl4AI under the one network policy", () => {
  it("SEC-52b: a gh search outside a non-empty fetch_allow is refused, recorded, and never run", async () => {
    user('research = "yes"\nfetch_allow = ["registry.npmjs.org"]');
    const { web } = await researchSources(repo, { log });
    expect(web).toBeDefined();
    const ran: string[][] = [];
    const r = await githubSearch("dedupe photos", "repos", {
      ...web,
      gh: async (args) => {
        ran.push(args);
        return "[]";
      },
    });
    expect(ran).toEqual([]);
    expect(String(r)).toMatch(/network policy refused api\.github\.com/);
    expect(await egress()).toContainEqual(
      expect.objectContaining({
        host: "api.github.com",
        allowed: false,
        purpose: "research:gh",
        reason: "research outside fetch_allow",
      }),
    );
  });

  it("SEC-52a: an allowed gh search runs and is logged", async () => {
    user('research = "yes"');
    const { web } = await researchSources(repo, { log });
    const ran: string[][] = [];
    await githubSearch("dedupe photos", "repos", {
      ...web,
      gh: async (args) => {
        ran.push(args);
        return "[]";
      },
    });
    expect(ran).toHaveLength(1);
    expect(await egress()).toContainEqual(
      expect.objectContaining({ host: "api.github.com", allowed: true, purpose: "research:gh" }),
    );
  });

  it("keeps Crawl4AI off while the policy refuses any public host, and says so", async () => {
    user('research = "yes"\nfetch_deny = ["evil.example"]');
    const denied = await researchSources(repo, { log });
    expect(denied.web?.crawler).toBeUndefined();
    expect(denied.status.pages).toMatch(/plain HTML reader/);
    user('research = "yes"\nfetch_allow = ["docs.example"]');
    expect((await researchSources(repo, { log })).web?.crawler).toBeUndefined();
    user('research = "yes"');
    expect((await researchSources(repo, { log })).web?.crawler).toBeDefined();
  });

  it("sends each page Crawl4AI reads through the policy and logs it", async () => {
    user('research = "yes"');
    const { web } = await researchSources(repo, { log });
    const crawled: string[] = [];
    const crawler: PageCrawler = {
      crawl: async (url) => {
        crawled.push(url);
        return { ok: true, title: "Doc", markdown: "x".repeat(400) };
      },
    };
    const text = await fetchPage("https://docs.example/guide", { ...web, crawler });
    expect(crawled).toEqual(["https://docs.example/guide"]);
    expect(text).toContain("# Doc");
    expect(await egress()).toContainEqual(
      expect.objectContaining({
        host: "docs.example",
        allowed: true,
        purpose: "research:crawl4ai",
      }),
    );
  });
});
