import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PoliteFetcher, ResearchCache } from "../src/research/polite.js";
import { researchSources } from "../src/research/service.js";
import { researchFetch, researchPolicy } from "../src/research_consent.js";

/**
 * Design-stage DS-N4-3 and DS-N4-4 on the research side: a domain in
 * `fetch_deny` is never fetched — not through the policy, not from the
 * research cache, not on the legacy switch — and the refusal names the file
 * and the rule; a project's widening is ignored and reported where a person
 * reads the research sources. Real files and a real ledger; no connection
 * is made (every host used is refused before any request).
 */
const dirs: string[] = [];
let userConfig: string;
let repo: string;
let log: EventLog;
let db: DatabaseSync;

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), "research-net-home-"));
  dirs.push(home);
  userConfig = join(home, "config.toml");
  vi.stubEnv("SEKHEMET_USER_CONFIG", userConfig);
  repo = mkdtempSync(join(tmpdir(), "research-net-repo-"));
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

const projectFile = () => join(repo, ".sekhemet", "config.toml");

describe("fetch_deny on every research path (DS-N4-3)", () => {
  it("refuses a denied subdomain through the policy in open mode, naming the user's file and the rule", async () => {
    writeFileSync(
      userConfig,
      '[network]\nmode = "open"\nresearch = "yes"\nfetch_deny = ["example.test"]\n',
    );
    await expect(researchFetch(repo, log)("https://docs.example.test/")).rejects.toThrow(
      userConfig,
    );
    const [refused] = (await log.getEventsByTypes(["harness/egress"])).map(
      (e) => e.payload as { allowed: boolean; reason?: string },
    );
    expect(refused?.allowed).toBe(false);
    expect(refused?.reason).toContain("example.test");
  });

  it("never serves a denied host's page from the research cache, naming the project's file", async () => {
    const cache = new ResearchCache(join(repo, "cache"));
    cache.set("https://docs.example.test/page", 200, "text/html", "cached body");
    const polite = new PoliteFetcher({
      cache,
      robots: false,
      fetch: async () => new Response("fresh"),
      deny: [{ rule: "example.test", file: projectFile() }],
    });
    await expect(polite.fetch("https://docs.example.test/page")).rejects.toThrow(projectFile());
    expect(await polite.permit("https://www.example.test/")).toContain("example.test");
    expect(polite.stats.cached).toBe(0);
    // Another host is untouched.
    expect(await (await polite.fetch("https://other.test/")).text()).toBe("fresh");
  });

  it("carries the deny rules to the legacy research switch, whatever mode says", async () => {
    writeFileSync(userConfig, '[network]\nmode = "open"\n');
    writeFileSync(projectFile(), '[network]\nfetch_deny = ["example.test"]\n');
    const { web } = await researchSources(repo, { forceWeb: true, ensure: async () => undefined });
    await expect(web?.polite?.fetch("https://docs.example.test/")).rejects.toThrow(
      /fetch_deny.*example\.test/,
    );
  });
});

describe("a project's widening is ignored and reported (DS-N4-4)", () => {
  it("fetches nothing on the project's account and says so in the research sources", async () => {
    writeFileSync(
      userConfig,
      '[network]\nmode = "allowlist"\nresearch = "yes"\nfetch_allow = ["docs.example.test"]\n',
    );
    writeFileSync(
      projectFile(),
      '[network]\nmode = "open"\nfetch_allow = ["docs.example.test", "evil.example.test"]\n',
    );
    const { policy } = researchPolicy(repo);
    expect(policy.fetchAllow).toEqual(["docs.example.test"]);
    await expect(researchFetch(repo, log)("https://evil.example.test/")).rejects.toThrow(
      /research outside fetch_allow/,
    );
    const { status } = await researchSources(repo, { ensure: async () => undefined, log });
    expect(status.ignored).toEqual([
      `${projectFile()}: mode = "open" ignored (a project's file may only narrow)`,
      `${projectFile()}: fetch_allow "evil.example.test" ignored (a project's file may only narrow)`,
    ]);
  });
});

describe("a fetch refusal never counts as a read (DS-N2-4)", () => {
  it("the network allowlist's refusal on the browser path is a refusal, and nothing is crawled", async () => {
    const { HostPacer } = await import("../src/research/polite.js");
    const { fetchPage, isFetchRefusal } = await import("../src/research/web.js");
    const polite = new PoliteFetcher({
      fetch: async () => new Response(""),
      pacer: new HostPacer({ now: () => 0, sleep: async () => {} }),
      allowOnly: ["nodejs.org"],
    });
    let crawled = 0;
    const crawler = {
      crawl: async () => {
        crawled++;
        return { ok: true, title: "Page", markdown: "real text ".repeat(60) };
      },
    };
    const text = await fetchPage("https://evil.example/page", { polite, crawler } as never);
    expect(text).toMatch(/not on the network allowlist/);
    expect(isFetchRefusal(text)).toBe(true);
    expect(crawled).toBe(0);
    // The plain reader's refusal (thrown by the fetcher) is one too.
    const plain = await fetchPage("https://evil.example/data.json", { polite } as never).catch(
      (err: Error) => err.message,
    );
    expect(isFetchRefusal(plain)).toBe(true);
  });

  it("a gate or a fetcher that fails with any message is a refusal, never page text", async () => {
    const { HostPacer } = await import("../src/research/polite.js");
    const { fetchPage, isFetchRefusal, readPaper } = await import("../src/research/web.js");
    let crawled = 0;
    const crawler = {
      crawl: async () => {
        crawled++;
        return { ok: true, title: "Page", markdown: "real text ".repeat(60) };
      },
    };
    const polite = () =>
      new PoliteFetcher({
        fetch: async () => new Response("real text ".repeat(60)),
        robots: false,
        pacer: new HostPacer({ now: () => 0, sleep: async () => {} }),
      });
    // The policy gate throws a message of its own (its egress record failed).
    const gated = await fetchPage("https://docs.example.org/page", {
      polite: polite(),
      crawler,
      gate: async () => {
        throw new Error("the egress record could not be written");
      },
    } as never);
    expect(isFetchRefusal(gated)).toBe(true);
    expect(crawled).toBe(0);
    // The plain reader's fetcher throws (a daily cap, a DNS failure): a refusal, not a throw.
    const capped = new PoliteFetcher({
      fetch: async () => {
        throw new Error("getaddrinfo ENOTFOUND docs.example.org");
      },
      robots: false,
      pacer: new HostPacer({ now: () => 0, sleep: async () => {} }),
    });
    const plain = await fetchPage("https://docs.example.org/data.json", {
      polite: capped,
    } as never);
    expect(isFetchRefusal(plain)).toBe(true);
    // A paper whose pages are refused is a refusal too, never an abstract read.
    const denied = new PoliteFetcher({
      fetch: async () => new Response("paper text ".repeat(400)),
      robots: false,
      deny: [{ rule: "arxiv.org", file: "the user's config.toml" }],
    });
    expect(
      isFetchRefusal(await readPaper("2605.03042", undefined, { polite: denied } as never)),
    ).toBe(true);
  });
});

describe("a research refusal never names an absolute home path", () => {
  it("names a deny rule's file under the home directory from ~", async () => {
    const { homedir } = await import("node:os");
    const polite = new PoliteFetcher({
      fetch: async () => new Response(""),
      robots: false,
      deny: [{ rule: "x.test", file: join(homedir(), ".config", "sekhemet", "config.toml") }],
    });
    const why = (await polite.permit("https://x.test/")) as string;
    expect(why).not.toContain(homedir());
    expect(why).toContain("~/.config/sekhemet/config.toml");
  });
});
