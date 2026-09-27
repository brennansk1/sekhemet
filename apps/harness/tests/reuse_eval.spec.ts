import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runResearchCommand } from "../src/research/cli.js";
import { builtInNeed, queryFor } from "../src/research/reuse.js";
import { type ReuseEvalResult, runReuseEval } from "../src/research/reuse_eval.js";
import { type LabelledNeed, REUSE_LABELLED_SET } from "../src/research/reuse_set.js";

/**
 * Design-stage DS-P7-7: the labelled set of about forty needs, each with the
 * package a professional would reach for (or "none"), and the runner that
 * records precision@1 and the correct-silence rate against real registries.
 * The live run needs the person's research consent: without it the runner
 * refuses and sends nothing. Here every HTTP answer is a fixture.
 */

let root: string;
let repo: string;
let userConfig: string;
let db: DatabaseSync;
let log: EventLog;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sek-reuse-eval-"));
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
  vi.restoreAllMocks();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const research = (answer: "yes" | "no") => {
  mkdirSync(dirname(userConfig), { recursive: true });
  writeFileSync(userConfig, `[network]\nresearch = "${answer}"\n`);
};

/** npm answers by keyword; GitHub finds nothing; every URL is counted. */
function fixtureFetch() {
  const urls: string[] = [];
  const pkg = (name: string, description: string, weekly: number) => ({
    package: { name, version: "1.0.0", description, license: "MIT" },
    downloads: { weekly },
  });
  const f = async (input: string | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("registry.npmjs.org")) {
      const text = new URL(url).searchParams.get("text") ?? "";
      if (text.includes("csv"))
        return Response.json({ objects: [pkg("csv-parse", "Parse CSV text", 5_000_000)] });
      if (text.includes("yaml"))
        return Response.json({ objects: [pkg("yaml-wrong", "Parse yaml documents", 5_000)] });
      return Response.json({ objects: [] });
    }
    if (url.includes("api.github.com")) return Response.json({ items: [] });
    return new Response("[]", { status: 200 });
  };
  return { f, urls };
}

const SMALL: LabelledNeed[] = [
  { id: "csv", need: "parse csv files", stack: "typescript", expect: ["csv-parse"] },
  { id: "yaml", need: "parse yaml documents", stack: "typescript", expect: ["yaml", "js-yaml"] },
  { id: "calc", need: "a calculator", stack: "typescript", expect: "none" },
];

describe("the labelled set", () => {
  it("has about forty needs, each labelled with its packages or none, in both ecosystems", () => {
    const set = REUSE_LABELLED_SET;
    expect(set.length).toBeGreaterThanOrEqual(36);
    expect(set.length).toBeLessThanOrEqual(44);
    expect(new Set(set.map((n) => n.id)).size).toBe(set.length);
    expect(new Set(set.map((n) => n.need.toLowerCase() + n.stack)).size).toBe(set.length);
    const none = set.filter((n) => n.expect === "none");
    expect(none.length).toBeGreaterThanOrEqual(8);
    expect(set.filter((n) => n.stack === "python").length).toBeGreaterThanOrEqual(8);
    for (const n of set) {
      expect(["typescript", "python"]).toContain(n.stack);
      if (n.expect !== "none") expect(n.expect.length).toBeGreaterThan(0);
    }
    // DS-P7-6's calculator is in the set, labelled none.
    expect(set.find((n) => n.need === "a calculator")?.expect).toBe("none");
    // A labelled package need is not one the survey would decline to search.
    for (const n of set.filter((x) => x.expect !== "none")) expect(builtInNeed(n.need)).toBe(false);
  });

  it("half its none needs go through a real search, so silence is not the word list's own verdict", () => {
    // Review of B4.5: a none need the built-in words decide sends no query and
    // exercises no filter; these are searched and must come back silent.
    const none = REUSE_LABELLED_SET.filter((n) => n.expect === "none");
    const searched = none.filter((n) => !builtInNeed(n.need));
    expect(searched.length * 2).toBeGreaterThanOrEqual(none.length);
    for (const n of searched) expect(queryFor(n.need).split(" ").length).toBeGreaterThanOrEqual(2);
    expect(new Set(searched.map((n) => n.stack))).toEqual(new Set(["typescript", "python"]));
  });
});

describe("DS-P7-7: the runner refuses without research consent", () => {
  it('sends nothing and records nothing when research = "no"', async () => {
    research("no");
    const { f, urls } = fixtureFetch();
    const lines: string[] = [];
    const r = await runReuseEval({
      repoPath: repo,
      log,
      fetchImpl: f,
      print: (l) => lines.push(l),
    });
    expect(r).toMatchObject({ refused: expect.stringMatching(/research consent/i) });
    expect(urls).toEqual([]);
    const events = await log.getEventsByTypes(["research/reuse_eval", "research/query"]);
    expect(events).toEqual([]);
  });

  it("refuses when research was never answered, and under --offline", async () => {
    const { f, urls } = fixtureFetch();
    const print = () => undefined;
    expect(await runReuseEval({ repoPath: repo, log, fetchImpl: f, print })).toHaveProperty(
      "refused",
    );
    research("yes");
    const offline = await runReuseEval({ repoPath: repo, log, fetchImpl: f, print, offline: true });
    expect(offline).toHaveProperty("refused");
    expect(urls).toEqual([]);
  });

  it("`sekhemet research --reuse-eval` exits non-zero without consent, before any request", async () => {
    research("no");
    const fetchSpy = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchSpy);
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      out.push(a.join(" "));
    });
    const code = await runResearchCommand(["--reuse-eval"], repo, undefined, log);
    vi.unstubAllGlobals();
    expect(code).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out.join("\n")).toMatch(/research consent/i);
  });
});

describe("DS-P7-7: the runner records precision@1 and the correct-silence rate", () => {
  it("scores the first recommendation per labelled need and silence on the none needs", async () => {
    research("yes");
    const { f } = fixtureFetch();
    const r = (await runReuseEval({
      repoPath: repo,
      log,
      fetchImpl: f,
      print: () => undefined,
      set: SMALL,
      paceMs: 0,
    })) as ReuseEvalResult;
    expect(r.precisionAt1).toBe(0.5);
    expect(r.correctSilence).toBe(1);
    expect(r.measured).toBe(3);
    expect(r.perNeed.map((n) => [n.id, n.top ?? null, n.correct])).toEqual([
      ["csv", "csv-parse", true],
      ["yaml", "yaml-wrong", false],
      ["calc", null, true],
    ]);
    const [event] = await log.getEventsByTypes(["research/reuse_eval"]);
    expect(event?.payload).toMatchObject({
      setHash: r.setHash,
      needs: 3,
      measured: 3,
      precisionAt1: 0.5,
      correctSilence: 1,
      baseline: false,
    });
  });

  it("compares a run with the baseline recorded on the same set, and says when it is lower", async () => {
    research("yes");
    const { f } = fixtureFetch();
    const run = (o: { baseline?: boolean; set?: LabelledNeed[] } = {}) =>
      runReuseEval({
        repoPath: repo,
        log,
        fetchImpl: f,
        print: () => undefined,
        set: o.set ?? SMALL,
        paceMs: 0,
        ...(o.baseline ? { baseline: true } : {}),
      }) as Promise<ReuseEvalResult>;
    const first = await run();
    expect(first.baseline).toBeUndefined();
    expect(first.belowBaseline).toBe(false);
    await run({ baseline: true });
    const same = await run();
    expect(same.baseline).toMatchObject({ precisionAt1: 0.5, correctSilence: 1 });
    expect(same.belowBaseline).toBe(false);
    // The yaml need relabelled: a different set, so a different baseline.
    const relabelled = SMALL.map((n) =>
      n.id === "yaml" ? { ...n, expect: ["yaml-wrong"] as const } : n,
    );
    const better = await run({ set: relabelled, baseline: true });
    expect(better.precisionAt1).toBe(1);
    expect(better.setHash).not.toBe(same.setHash);
    // Against its own baseline the first set is unchanged, never compared with the other.
    expect((await run()).belowBaseline).toBe(false);
  });

  it("reports silence on the searched none needs apart from the ones the language covers", async () => {
    research("yes");
    const { f, urls } = fixtureFetch();
    const set: LabelledNeed[] = [
      ...SMALL,
      {
        id: "refund",
        need: "works out the refund owed on a returned order",
        stack: "typescript",
        expect: "none",
      },
      // The fixture's npm answers any yaml query: a searched none need that is not silent.
      {
        id: "yaml-none",
        need: "parse yaml documents for invoices",
        stack: "typescript",
        expect: "none",
      },
    ];
    const r = (await runReuseEval({
      repoPath: repo,
      log,
      fetchImpl: f,
      print: () => undefined,
      set,
      paceMs: 0,
    })) as ReuseEvalResult;
    expect(r.perNeed.map((n) => [n.id, n.searched])).toEqual([
      ["csv", true],
      ["yaml", true],
      ["calc", false],
      ["refund", true],
      ["yaml-none", true],
    ]);
    expect(urls.some((u) => decodeURIComponent(u).includes("refund"))).toBe(true);
    expect(r.correctSilence).toBeCloseTo(2 / 3);
    expect(r.searchedSilence).toBe(0.5);
    const [event] = await log.getEventsByTypes(["research/reuse_eval"]);
    expect(event?.payload).toMatchObject({ searchedSilence: 0.5 });
  });

  it("a need whose search could not run is not measured, never counted as silence", async () => {
    research("yes");
    const down = async () => {
      throw new Error("ENOTFOUND");
    };
    const r = (await runReuseEval({
      repoPath: repo,
      log,
      fetchImpl: down,
      print: () => undefined,
      set: SMALL,
      paceMs: 0,
    })) as ReuseEvalResult;
    // The calculator is decided without a search; the other two could not be measured.
    expect(r.measured).toBe(1);
    expect(r.perNeed.filter((n) => n.unmeasured).map((n) => n.id)).toEqual(["csv", "yaml"]);
    expect(r.precisionAt1).toBeUndefined();
    expect(r.correctSilence).toBe(1);
  });
});
