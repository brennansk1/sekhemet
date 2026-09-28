import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ReuseEvalResult, runReuseEval } from "../src/research/reuse_eval.js";
import { REUSE_LABELLED_SET } from "../src/research/reuse_set.js";
import { RESEARCH_HOSTS } from "../src/research_consent.js";
import { registryFixture } from "./reuse_registry_fixture.js";

/**
 * DS-P7-7 measured offline: the whole labelled set through the product's
 * runner, every source answered by the fixture registry
 * (`reuse_registry_fixture.ts`). No model is assigned, so the queries are
 * the deterministic fallback's. The floors are the numbers the survey scored
 * on this corpus before BM25 ranking replaced registry order and five-letter
 * stems (compliance C3, measured on 3410f94's survey): precision@1 14 of 34,
 * correct silence 10 of 10. A later change may not score lower (DS-P7-7).
 * After C3 the survey scored 17 of 34 and 10 of 10.
 */
const BEFORE = { precisionAt1: 14 / 34, correctSilence: 1 };

let root: string;
let repo: string;
let userConfig: string;
let db: DatabaseSync;
let log: EventLog;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sek-reuse-offline-"));
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
afterEach(() => {
  vi.unstubAllEnvs();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const allow = (hosts: readonly string[]) => {
  mkdirSync(dirname(userConfig), { recursive: true });
  writeFileSync(
    userConfig,
    `[network]\nresearch = "yes"\nresearch_hosts = [${hosts.map((h) => `"${h}"`).join(", ")}]\n`,
  );
};

async function measure(hosts: readonly string[]): Promise<ReuseEvalResult & { urls: string[] }> {
  allow(hosts);
  const { fetchImpl, urls } = registryFixture();
  const r = (await runReuseEval({
    repoPath: repo,
    log,
    fetchImpl,
    print: () => undefined,
    paceMs: 0,
  })) as ReuseEvalResult;
  return { ...r, urls };
}

describe("DS-P7-7 offline: the labelled set against the fixture registry", () => {
  it("measures every need, and scores no lower than the pre-change survey", async () => {
    const r = await measure(RESEARCH_HOSTS.filter((h) => h !== "api.deps.dev"));
    expect(r.needs).toBe(REUSE_LABELLED_SET.length);
    expect(r.measured).toBe(REUSE_LABELLED_SET.length);
    expect(r.precisionAt1).toBeGreaterThanOrEqual(BEFORE.precisionAt1);
    expect(r.correctSilence).toBeGreaterThanOrEqual(BEFORE.correctSilence);
    expect(r.urls.some((u) => u.includes("api.deps.dev"))).toBe(false);
  });

  it("with deps.dev allowed, asks it about candidates and scores the same on a corpus it agrees with", async () => {
    const without = await measure(RESEARCH_HOSTS.filter((h) => h !== "api.deps.dev"));
    const withDepsDev = await measure(RESEARCH_HOSTS);
    expect(withDepsDev.urls.some((u) => u.startsWith("https://api.deps.dev/v3/systems/"))).toBe(
      true,
    );
    expect(withDepsDev.measured).toBe(REUSE_LABELLED_SET.length);
    expect(withDepsDev.precisionAt1).toBe(without.precisionAt1);
    expect(withDepsDev.correctSilence).toBe(without.correctSilence);
  });
});
