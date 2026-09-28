import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { type InferenceRequest, MockInferenceAdapter, plannerCopy } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import type { LibraryCandidate } from "../src/pm/libraries.js";
import {
  REUSE_QUERIES_MEASURED,
  capabilityQueries,
  cleanQuery,
  queriesFromReply,
  reuseQueriesPromptHash,
} from "../src/research/capability_queries.js";
import { type ResearchQuery, reuseSurvey } from "../src/research/reuse.js";
import { type Kernel, planCommand } from "../src/wave2.js";

/**
 * Design-stage §2.5 item 1 (compliance C3; domain08 review §6 item 1): the
 * Planning model writes one to three capability queries per need through
 * its adapter, from a registered copy module (`plannerCopy`); without a
 * Planning model, or with one off this machine or answering badly, the
 * need's keywords are the deterministic fallback. Every model here is a
 * scripted mock; no model is loaded.
 */

const NOW = new Date("2026-09-27T00:00:00Z");
const usage = { promptTokens: 1, completionTokens: 1, durationMs: 1 };
const reply = (text: string) => ({ text, toolCalls: [], usage });

/** A Planning model that answers the query prompt with `text`, and anything else by default. */
const planner = (text: string) =>
  new MockInferenceAdapter("planner", [], {
    exhaustion: "default",
    rules: [
      { match: (r) => r.systemPrompt === plannerCopy.reuseQueriesSystem, response: reply(text) },
    ],
  });

const lib = (name: string, description: string): LibraryCandidate => ({
  name,
  ecosystem: "npm",
  version: "1.0.0",
  license: "MIT",
  description,
  weeklyDownloads: 100_000,
  publishedAt: "2026-06-01T00:00:00Z",
  url: `https://www.npmjs.com/package/${name}`,
});

describe("capabilityQueries", () => {
  it("asks the Planning model at temperature 0 with the capability and language only", async () => {
    const model = planner('{"queries": ["email sending", "smtp client"]}');
    const q = await capabilityQueries("sends invoices to customers", {
      planner: model,
      stack: "python",
    });
    expect(q).toEqual({ queries: ["email sending", "smtp client"], origin: "planning-model" });
    const [req] = model.callHistory as InferenceRequest[];
    expect(req?.systemPrompt).toBe(plannerCopy.reuseQueriesSystem);
    expect(req?.prompt).toBe(
      plannerCopy.reuseQueries("sends invoices to customers", "Python (PyPI)"),
    );
    expect(req?.temperature).toBe(0);
    expect(req?.purpose).toBe("planning");
  });

  it("falls back to the need's keywords with no model, a remote one, a failure or no usable answer", async () => {
    const keywords = { queries: ["sends invoices customers"], origin: "keywords" };
    const need = "sends invoices to customers";
    expect(await capabilityQueries(need)).toEqual(keywords);

    const remote = Object.assign(planner('{"queries": ["email"]}'), { remote: true });
    expect(await capabilityQueries(need, { planner: remote })).toEqual(keywords);
    expect(remote.callHistory).toEqual([]);

    const failing = planner("");
    failing.generate = async () => {
      throw new Error("server gone");
    };
    expect(await capabilityQueries(need, { planner: failing })).toEqual(keywords);
    expect(await capabilityQueries(need, { planner: planner("I would search npm.") })).toEqual(
      keywords,
    );
    expect(await capabilityQueries(need, { planner: planner('{"queries": []}') })).toEqual(
      keywords,
    );
  });

  it("cuts what may leave the machine to three short plain-word queries", () => {
    expect(cleanQuery("  Email Sending!! ")).toBe("email sending");
    expect(cleanQuery("send the acme merger invoices to bob@example.com now")).toBe(
      "send the acme merger",
    );
    expect(cleanQuery(42)).toBeUndefined();
    expect(
      queriesFromReply(
        '{"queries": ["csv parser", "CSV parser", "csv reader", "csv stream", "tsv parser"]}',
      ),
    ).toEqual(["csv parser", "csv reader", "csv stream"]);
  });
});

describe("the survey searches by the Planning model's capability queries", () => {
  it("sends each query to npm, the first to GitHub, and records who wrote them", async () => {
    const sentLibraries: string[] = [];
    const sentRepos: string[] = [];
    const recorded: ResearchQuery[] = [];
    const [f] = await reuseSurvey(
      ["charges customers every month"],
      {
        libraries: async (q) => {
          sentLibraries.push(q);
          return q === "subscription billing"
            ? [lib("billing-kit", "Recurring subscription billing for SaaS")]
            : [];
        },
        repos: async (q) => {
          sentRepos.push(q);
          return [];
        },
        record: (q) => {
          recorded.push(q);
        },
      },
      {
        now: NOW,
        planner: planner('{"queries": ["subscription billing", "payment provider sdk"]}'),
      },
    );
    expect(sentLibraries).toEqual(["subscription billing", "payment provider sdk"]);
    expect(sentRepos).toEqual(["subscription billing"]);
    // Relevant through the capability query, though it shares no word with the need.
    expect(f?.libraries.map((l) => l.name)).toEqual(["billing-kit"]);
    expect(f?.origin).toBe("planning-model");
    expect(f?.queries).toEqual(["subscription billing", "payment provider sdk"]);
    expect(recorded.every((q) => q.origin === "planning-model")).toBe(true);
  });

  it("without a Planning model sends the keywords and finds nothing the need's words do not name", async () => {
    const sent: string[] = [];
    const [f] = await reuseSurvey(
      ["charges customers every month"],
      {
        libraries: async (q) => {
          sent.push(q);
          return [lib("billing-kit", "Recurring subscription billing for SaaS")];
        },
        repos: async () => [],
      },
      { now: NOW },
    );
    expect(sent).toEqual(["charges customers every month"]);
    expect(f?.origin).toBe("keywords");
    expect(f?.libraries).toEqual([]);
  });

  it("a Python project sends only the first query, once, to its GitHub-backed search", async () => {
    const sent: string[] = [];
    await reuseSurvey(
      ["reads spreadsheets"],
      {
        libraries: async (q) => {
          sent.push(`lib:${q}`);
          return [];
        },
        repos: async (q) => {
          sent.push(`repo:${q}`);
          return [];
        },
      },
      { now: NOW, stack: "python", planner: planner('{"queries": ["excel reader", "xlsx"]}') },
    );
    expect(sent).toEqual(["lib:excel reader", "repo:excel reader"]);
  });
});

describe("plan hands the Planning model to the survey (wave2 planCommand)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
  });

  function kernel(): Kernel {
    const repoPath = mkdtempSync(join(tmpdir(), "sek-cap-queries-"));
    dirs.push(repoPath);
    mkdirSync(dirname(join(repoPath, "src/app.ts")), { recursive: true });
    writeFileSync(join(repoPath, "src/app.ts"), "export const a = 1;\n");
    const git = (...a: string[]) => execFileSync("git", a, { cwd: repoPath });
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

  it("the sketcher writes the capability queries the registries receive, once admitted", async () => {
    const k = kernel();
    // DS-S8-3 as the owner amended it on 2026-09-28: only an admitted model's
    // queries leave the machine (reuse_queries_admission.spec.ts covers the rest).
    await k.log.append({
      actor: "harness",
      type: REUSE_QUERIES_MEASURED,
      payload: {
        model: "planner",
        promptHash: reuseQueriesPromptHash(),
        setHash: "a".repeat(64),
        n: 44,
        keywords: { p1: 0.5, silence: 1, measured: 44 },
        modelQueries: { p1: 0.7, silence: 1, measured: 44 },
        fromModel: 40,
        admitted: true,
      },
    });
    const sent: string[] = [];
    await planCommand(k, "a service that charges customers every month", {
      print: () => undefined,
      sketcher: planner('{"queries": ["subscription billing"]}'),
      research: {
        libraries: async (q) => {
          sent.push(q);
          return [];
        },
        repos: async () => [],
      },
    });
    expect(sent).toContain("subscription billing");
    expect(sent.every((q) => q === "subscription billing")).toBe(true);
  });
});
