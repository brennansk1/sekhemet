import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { MockInferenceAdapter, plannerCopy } from "@sekhemet/models";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  REUSE_QUERIES_MEASURED,
  reuseQueriesAdmitted,
  reuseQueriesPromptHash,
} from "../src/research/capability_queries.js";
import { runResearchCommand } from "../src/research/cli.js";
import type { ResearchQuery } from "../src/research/reuse.js";
import { type ReuseQueriesMeasurement, measureReuseQueries } from "../src/research/reuse_eval.js";
import type { LabelledNeed } from "../src/research/reuse_set.js";
import { type RepoContext, planCommand } from "../src/wave2.js";

/**
 * Design-stage DS-S8-3 as the owner amended it on 2026-09-28: queries the
 * local Planning model writes may leave the machine, but only once a live
 * measurement has admitted that model (PROMPT_STANDARD's admission for
 * `planner.reuse_queries`). `sekhemet research --reuse-eval --planner <model>`
 * runs the labelled set twice — keyword queries, then the model's — and
 * records `research/reuse_queries_measured`; `plan` hands the Planning model
 * to the survey only when the latest such event for that exact model, on the
 * current prompt, says admitted. Every model here is a scripted mock and
 * every HTTP answer a fixture: no model is loaded and nothing is sent.
 */

let root: string;
let repo: string;
let userConfig: string;
let db: DatabaseSync;
let log: EventLog;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sek-reuse-admit-"));
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

const usage = { promptTokens: 1, completionTokens: 1, durationMs: 1 };

/** A Planning model that answers each capability with the queries named for it. */
function plannerFor(answers: Record<string, string[]>, id = "planner-a") {
  return new MockInferenceAdapter(id, [], {
    exhaustion: "default",
    rules: Object.entries(answers).map(([need, queries]) => ({
      match: (r: { systemPrompt?: string; prompt: string }) =>
        r.systemPrompt === plannerCopy.reuseQueriesSystem &&
        r.prompt.startsWith(`Capability: ${need}\n`),
      response: { text: JSON.stringify({ queries }), toolCalls: [], usage },
    })),
  });
}

/** npm answers by query text; GitHub finds nothing, or fails on a named query. */
function fixtureFetch(o: { githubFailsOn?: string } = {}) {
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
      if (text === "yaml parser")
        return Response.json({ objects: [pkg("yaml", "YAML parser and stringifier", 9_000_000)] });
      if (text.includes("yaml"))
        return Response.json({ objects: [pkg("yaml-wrong", "Parse yaml documents", 5_000)] });
      if (text === "refund calculator")
        return Response.json({
          objects: [pkg("refund-calc", "Refund calculator for returned orders", 2_000_000)],
        });
      return Response.json({ objects: [] });
    }
    if (url.includes("api.github.com")) {
      const q = new URL(url).searchParams.get("q") ?? "";
      if (o.githubFailsOn && q.includes(o.githubFailsOn))
        return new Response("rate limited", { status: 403 });
      return Response.json({ items: [] });
    }
    return new Response("[]", { status: 200 });
  };
  return { f, urls };
}

const SMALL: LabelledNeed[] = [
  { id: "csv", need: "parse csv files", stack: "typescript", expect: ["csv-parse"] },
  { id: "yaml", need: "parse yaml documents", stack: "typescript", expect: ["yaml", "js-yaml"] },
  { id: "calc", need: "a calculator", stack: "typescript", expect: "none" },
];
const REFUND: LabelledNeed = {
  id: "refund",
  need: "works out the refund owed on a returned order",
  stack: "typescript",
  expect: "none",
};
const GOOD = { "parse csv files": ["csv parser"], "parse yaml documents": ["yaml parser"] };

const measure = (
  o: {
    set?: LabelledNeed[];
    model?: MockInferenceAdapter;
    fetch?: ReturnType<typeof fixtureFetch>;
    print?: (l: string) => void;
  } = {},
) => {
  const loads: string[] = [];
  const model = o.model ?? plannerFor(GOOD);
  const run = measureReuseQueries({
    repoPath: repo,
    log,
    fetchImpl: (o.fetch ?? fixtureFetch()).f,
    print: o.print ?? (() => undefined),
    set: o.set ?? SMALL,
    paceMs: 0,
    loadPlanner: async () => {
      loads.push(model.modelId);
      return model;
    },
  });
  return { run, loads };
};

describe("the measurement: keyword queries against the Planning model's, on the labelled set", () => {
  it("scores both, admits the model when precision@1 rises and silence holds, and records one event", async () => {
    research("yes");
    const lines: string[] = [];
    const { run, loads } = measure({ print: (l) => lines.push(l) });
    const r = (await run) as ReuseQueriesMeasurement;
    expect(loads).toEqual(["planner-a"]);
    expect(r.keywords).toMatchObject({ p1: 0.5, silence: 1, measured: 3 });
    expect(r.modelQueries).toMatchObject({ p1: 1, silence: 1, measured: 3 });
    expect(r.fromModel).toBe(2);
    expect(r.admitted).toBe(true);
    const events = await log.getEventsByTypes([REUSE_QUERIES_MEASURED]);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      model: "planner-a",
      promptHash: reuseQueriesPromptHash(),
      n: 3,
      keywords: { p1: 0.5, silence: 1, measured: 3 },
      modelQueries: { p1: 1, silence: 1, measured: 3 },
      fromModel: 2,
      admitted: true,
    });
    // Neither arm is recorded as the survey's own measurement.
    expect(await log.getEventsByTypes(["research/reuse_eval"])).toEqual([]);
    const said = lines.join("\n");
    expect(said).toMatch(/Keyword queries: precision@1 50%.*correct silence 100%/);
    expect(said).toMatch(/planner-a's queries: precision@1 100%.*correct silence 100%/);
    expect(said).toMatch(/admitted/i);
  });

  it("does not admit a model whose correct silence falls, even with a better precision@1", async () => {
    research("yes");
    const model = plannerFor({ ...GOOD, [REFUND.need]: ["refund calculator"] });
    const r = (await measure({ set: [...SMALL, REFUND], model }).run) as ReuseQueriesMeasurement;
    expect(r.modelQueries.p1).toBe(1);
    expect(r.keywords.silence).toBe(1);
    expect(r.modelQueries.silence).toBe(0.5);
    expect(r.admitted).toBe(false);
    const [event] = await log.getEventsByTypes([REUSE_QUERIES_MEASURED]);
    expect(event?.payload).toMatchObject({ admitted: false });
  });

  it("does not admit a model that only matches the keywords", async () => {
    research("yes");
    // It answers nothing usable, so every need falls back to its keywords.
    const r = (await measure({ model: plannerFor({}) }).run) as ReuseQueriesMeasurement;
    expect(r.fromModel).toBe(0);
    expect(r.modelQueries.p1).toBe(r.keywords.p1);
    expect(r.admitted).toBe(false);
  });

  it("does not admit when a need could not be measured in either run", async () => {
    research("yes");
    const r = (await measure({ fetch: fixtureFetch({ githubFailsOn: "yaml parser" }) })
      .run) as ReuseQueriesMeasurement;
    expect(r.modelQueries.measured).toBe(2);
    expect(r.admitted).toBe(false);
  });

  it("refuses without research consent, before loading the model, recording nothing", async () => {
    research("no");
    const { f, urls } = fixtureFetch();
    const { run, loads } = measure({ fetch: { f, urls } });
    expect(await run).toHaveProperty("refused");
    expect(loads).toEqual([]);
    expect(urls).toEqual([]);
    expect(await log.getEventsByTypes([REUSE_QUERIES_MEASURED])).toEqual([]);
  });

  it("`research --reuse-eval --planner` refuses a model the registry does not list, loading nothing", async () => {
    research("yes");
    const fetchSpy = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchSpy);
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      out.push(a.join(" "));
    });
    const code = await runResearchCommand(
      ["--reuse-eval", "--planner", "no-such-model-xyz"],
      repo,
      undefined,
      log,
    );
    const missing = await runResearchCommand(["--reuse-eval", "--planner"], repo, undefined, log);
    vi.unstubAllGlobals();
    expect(code).toBe(1);
    expect(missing).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out.join("\n")).toMatch(/no-such-model-xyz.*not in Sekhemet's model list/);
    expect(await log.getEventsByTypes([REUSE_QUERIES_MEASURED])).toEqual([]);
  });
});

describe("plan sends the Planning model's queries only once its admission is recorded", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
  });

  function kernel(): RepoContext {
    const repoPath = mkdtempSync(join(tmpdir(), "sek-reuse-admit-plan-"));
    dirs.push(repoPath);
    mkdirSync(join(repoPath, "src"), { recursive: true });
    writeFileSync(join(repoPath, "src/app.ts"), "export const a = 1;\n");
    const git = (...a: string[]) => execFileSync("git", a, { cwd: repoPath });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "e@x");
    git("config", "user.name", "E");
    git("add", "-A");
    git("commit", "-q", "-m", "feat: init");
    mkdirSync(join(repoPath, ".sekhemet"), { recursive: true });
    const kdb = new DatabaseSync(join(repoPath, ".sekhemet", "events.db"));
    initSchema(kdb);
    const klog = new EventLog(kdb);
    return { repoPath, log: klog, cardStore: new CardStore(kdb, klog) };
  }

  const measured = (model: string, admitted: boolean, promptHash = reuseQueriesPromptHash()) => ({
    actor: "harness",
    type: REUSE_QUERIES_MEASURED,
    payload: {
      model,
      promptHash,
      setHash: "a".repeat(64),
      n: 44,
      keywords: { p1: 0.5, silence: 1, measured: 44 },
      modelQueries: { p1: admitted ? 0.7 : 0.4, silence: 1, measured: 44 },
      fromModel: 30,
      admitted,
    },
  });

  async function planWith(k: RepoContext) {
    const sent: string[] = [];
    const recorded: ResearchQuery[] = [];
    await planCommand(k, "a service that charges customers every month", {
      print: () => undefined,
      // It answers every capability the plan asks about with one query.
      sketcher: new MockInferenceAdapter("planner-a", [], {
        exhaustion: "default",
        rules: [
          {
            match: (r) => r.systemPrompt === plannerCopy.reuseQueriesSystem,
            response: { text: '{"queries": ["subscription billing"]}', toolCalls: [], usage },
          },
        ],
      }),
      research: {
        libraries: async (q) => {
          sent.push(q);
          return [];
        },
        repos: async () => [],
        record: (q) => {
          recorded.push(q);
        },
      },
    });
    return { sent, origins: [...new Set(recorded.map((q) => q.origin))] };
  }

  it("with no measurement recorded, the keywords are sent and recorded as such", async () => {
    const k = kernel();
    expect(await reuseQueriesAdmitted(k.log, "planner-a")).toBe(false);
    const { sent, origins } = await planWith(k);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent).not.toContain("subscription billing");
    expect(origins).toEqual(["keywords"]);
  });

  it("with the latest measurement not admitting the model, the keywords are sent", async () => {
    const k = kernel();
    await k.log.append(measured("planner-a", true));
    await k.log.append(measured("planner-a", false));
    const { sent, origins } = await planWith(k);
    expect(sent).not.toContain("subscription billing");
    expect(origins).toEqual(["keywords"]);
  });

  it("with the model admitted, its capability queries are sent", async () => {
    const k = kernel();
    await k.log.append(measured("planner-a", true));
    expect(await reuseQueriesAdmitted(k.log, "planner-a")).toBe(true);
    const { sent, origins } = await planWith(k);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((q) => q === "subscription billing")).toBe(true);
    expect(origins).toEqual(["planning-model"]);
  });

  it("another model's admission, or one measured on a different prompt, does not count", async () => {
    const k = kernel();
    await k.log.append(measured("planner-b", true));
    await k.log.append(measured("planner-a", true, "b".repeat(64)));
    expect(await reuseQueriesAdmitted(k.log, "planner-a")).toBe(false);
    const { sent, origins } = await planWith(k);
    expect(sent).not.toContain("subscription billing");
    expect(origins).toEqual(["keywords"]);
  });
});
