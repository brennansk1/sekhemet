import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventLog, initSchema } from "@sekhemet/kernel";
import { cardAllowlist, mergeNetworkConfigs, policyFetch } from "@sekhemet/sandbox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { networkConfigs } from "../src/config_apply.js";
import { researchConsentCheck } from "../src/doctor.js";
import { researchSources } from "../src/research/service.js";
import {
  askResearchOnce,
  recordResearchAnswer,
  researchAnswer,
  researchFetch,
} from "../src/research_consent.js";

/**
 * NEW-security-8 (security.md item 29a; SEC-52, SEC-52a, SEC-52b): the
 * one-time research question, recorded once in the user's config.toml;
 * research the one exception to `mode`, through the one network policy and
 * logged on the ledger; never a sandbox route. Real files, a real ledger;
 * no connection is made (every host used is refused, or does not resolve).
 */
const dirs: string[] = [];
let userConfig: string;
let repo: string;
let log: EventLog;
let db: DatabaseSync;

beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), "research-home-"));
  dirs.push(home);
  userConfig = join(home, "config.toml");
  vi.stubEnv("SEKHEMET_USER_CONFIG", userConfig);
  repo = mkdtempSync(join(tmpdir(), "research-repo-"));
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

const policy = () => {
  const n = networkConfigs(repo);
  return mergeNetworkConfigs(n.user, n.project);
};
const egress = async () =>
  (await log.getEventsByTypes(["harness/egress"])).map(
    (e) => e.payload as { host: string; allowed: boolean; reason?: string; purpose: string },
  );
const POLICY_REASONS = /offline|fetch_deny|fetch_allow/;

describe("harness/egress keeps the URL private and erasable (kernel rule 33, B4.9 lead review)", () => {
  it("records the host and a hash of the URL in the chain, and the URL itself only in the private part", async () => {
    const url = "https://docs.example.test/search?q=my+private+question";
    await expect(researchFetch(repo, log)(url)).rejects.toThrow(/research not allowed/);
    const [e] = await log.getEventsByTypes(["harness/egress"]);
    const payload = e?.payload as Record<string, unknown>;
    expect(payload.url).toBeUndefined();
    expect(payload.host).toBe("docs.example.test");
    expect(payload.urlHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(payload)).not.toContain("private+question");
    expect((e?.private as { url?: string } | undefined)?.url).toBe(url);
  });

  it("fails the request when its record cannot be written (security item 33)", async () => {
    const failing = {
      append: async () => {
        throw new Error("ledger unavailable");
      },
    } as unknown as EventLog;
    await expect(researchFetch(repo, failing)("https://docs.example.test/")).rejects.toThrow(
      /ledger unavailable/,
    );
  });
});

describe("NEW-security-8: the one-time research question", () => {
  it("SEC-52: before the answer nothing goes out; a yes is recorded once in config.toml, never asked again, and opens no sandbox route", async () => {
    writeFileSync(userConfig, '# mine\n[models]\nworker = "cyber-tiel"\n');
    // Unanswered, and no person to ask (no TTY): nothing is recorded, and a
    // research fetch is refused before any connection.
    expect(await askResearchOnce({})).toBeUndefined();
    expect(researchAnswer()).toBeUndefined();
    await expect(researchFetch(repo, log)("https://docs.example.test/")).rejects.toThrow(
      /research not allowed/,
    );
    expect((await egress()).map((e) => e.allowed)).toEqual([false]);

    // The person answers yes: recorded in their config.toml, which keeps the rest.
    let asked = 0;
    const ask = async () => {
      asked++;
      return true;
    };
    expect(await askResearchOnce({ ask })).toBe("yes");
    expect(asked).toBe(1);
    const text = readFileSync(userConfig, "utf8");
    expect(text).toContain('worker = "cyber-tiel"');
    expect(text).toMatch(/\[network\][\s\S]*research = "yes"/);
    // A later project: not asked again.
    expect(await askResearchOnce({ ask })).toBe("yes");
    expect(asked).toBe(1);
    // A card's sandboxed commands get no host beyond the repository's network_allow.
    expect(cardAllowlist(policy(), ["registry.npmjs.org"])).toEqual([]);
  });

  it("SEC-52a: research yes, mode offline, no fetch_allow — the Researcher may fetch a public host, logged; nothing else goes out", async () => {
    recordResearchAnswer("yes");
    const p = policy();
    expect(p).toMatchObject({ mode: "offline", research: "yes", fetchAllow: [] });
    // The policy lets it through (the host does not resolve: the failure is
    // the network's, not a refusal).
    await expect(researchFetch(repo, log)("https://example.invalid/")).rejects.toThrow();
    const [research] = await egress();
    expect(research?.purpose).toBe("research");
    expect(research?.reason ?? "").not.toMatch(POLICY_REASONS);
    // A supply-chain lookup stays offline.
    await expect(
      policyFetch(p, { purpose: "supply-chain" })("https://registry.npmjs.org/x"),
    ).rejects.toThrow(/offline/);
    // Card commands: no route out.
    expect(cardAllowlist(p, ["example.com"])).toEqual([]);
    // The Researcher's web is on, through the policy.
    const { web } = await researchSources(repo, { ensure: async () => undefined, log });
    expect(web?.polite).toBeDefined();
  });

  it("SEC-52b: a non-empty fetch_allow bounds research whatever mode says; a project's no stops research; a project's yes under the user's no is ignored and named by doctor", async () => {
    writeFileSync(
      userConfig,
      '[network]\nmode = "open"\nresearch = "yes"\nfetch_allow = ["docs.example.test"]\n',
    );
    await expect(researchFetch(repo, log)("https://other.example.test/")).rejects.toThrow(
      /research outside fetch_allow/,
    );
    expect((await egress()).at(-1)).toMatchObject({ allowed: false, host: "other.example.test" });

    // The project says no: no research request for it.
    writeFileSync(join(repo, ".sekhemet", "config.toml"), '[network]\nresearch = "no"\n');
    expect(policy().research).toBe("no");
    await expect(researchFetch(repo, log)("https://docs.example.test/")).rejects.toThrow(
      /research not allowed/,
    );
    const off = await researchSources(repo, { ensure: async () => undefined, log });
    expect(off.web).toBeUndefined();

    // The user says no, the project yes: ignored, and doctor names it.
    writeFileSync(userConfig, '[network]\nresearch = "no"\n');
    writeFileSync(join(repo, ".sekhemet", "config.toml"), '[network]\nresearch = "yes"\n');
    expect(policy().research).toBe("no");
    const check = researchConsentCheck(repo);
    expect(check.status).toBe("warn");
    expect(check.detail).toMatch(/research = "yes" is ignored/);
  });
});

describe("DS-S8-8: a yes covers exactly the hosts it named", () => {
  it("a first yes records the hosts the question named; doctor names a host an older yes did not", () => {
    recordResearchAnswer("yes");
    expect(networkConfigs(repo).user.researchHosts).toContain("pypi.org");
    expect(researchConsentCheck(repo).detail).not.toMatch(/await/);
    writeFileSync(userConfig, '[network]\nresearch = "yes"\n');
    // The hosts added since the unlisted yes: pypi.org (B4.5) and api.deps.dev (C3, DEC-44).
    expect(researchConsentCheck(repo).detail).toMatch(/pypi\.org, api\.deps\.dev await a yes/);
  });
});
