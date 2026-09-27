import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import type { InferenceRequest, InferenceResponse, LocalInferenceAdapter } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import { ledgerEvidenceSummary } from "../src/ledger_evidence.js";
import { EvidenceLedger } from "../src/research/apodex_loop.js";
import { researchNote, runResearchCard } from "../src/research/cards.js";
import { acceptRevision } from "../src/research/claims.js";
import { runResearchCommand } from "../src/research/cli.js";
import { critiquePass, parseDisagreements } from "../src/research/critique.js";
import { EFFORT_CAPS, effortOfLabels } from "../src/research/effort.js";
import { investigate, research, withClaims } from "../src/research/researcher.js";
import { ResearchMemory, ResearchService } from "../src/research/service.js";
import { independentHosts } from "../src/research/sources.js";
import { leasePath, newLease } from "../src/runner_lease.js";

/**
 * Design-stage NEW-design-stage-2 and -4: research that can be verified and
 * deep research that says how hard it looked. Scripted models (no model is
 * loaded), fake pages, real SQLite, the production board.
 */
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};

type Step = (req: InferenceRequest) => Partial<InferenceResponse>;
function scripted(steps: Step[]): LocalInferenceAdapter & { requests: InferenceRequest[] } {
  const requests: InferenceRequest[] = [];
  let i = 0;
  return {
    modelId: "generic-researcher",
    supportedArms: ["arm_a_flat"],
    nativeTools: true,
    contextWindow: { contextTokens: 16384, maxTokens: 1500 },
    requests,
    async generate(req) {
      requests.push(structuredClone(req));
      const step = steps[Math.min(i++, steps.length - 1)] as Step;
      return {
        text: "",
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
        ...step(req),
      };
    },
  };
}

const PAGE = `<html><body><h1>Docs</h1><p>${"The parse function returns a record. ".repeat(20)}</p></body></html>`;
const pagesWeb = () => {
  const fetched: string[] = [];
  return {
    fetched,
    web: {
      fetch: async (url: string) => {
        fetched.push(url);
        return new Response(PAGE, { headers: { "content-type": "text/html" } });
      },
    },
  };
};

describe("the closing rule: two independent hosts of primary or secondary tier (DS-N4-2)", () => {
  it("counts hosts, not pages, and only primary or secondary ones", () => {
    expect(
      independentHosts([
        { kind: "documentation", ref: "https://nodejs.org/api/a.html" },
        { kind: "documentation", ref: "https://nodejs.org/api/b.html" },
        { kind: "web", ref: "https://someblog.example/post" },
      ]),
    ).toEqual(["nodejs.org"]);
    expect(
      independentHosts([
        { kind: "documentation", ref: "npm README of zod" },
        { kind: "source", ref: "https://github.com/colinhacks/zod/blob/main/README.md" },
      ]),
    ).toEqual(["github.com", "npmjs.com"]);
  });

  it("re-dispatches an open sub-question once with different queries, then reports it uncovered", async () => {
    const searched: string[] = [];
    const model = scripted([
      // Plan: one sub-question.
      () => ({ text: '["zod object parsing"]' }),
      // Dispatch 1: one source, one host.
      () => ({ toolCalls: [{ id: "a", name: "package_readme", arguments: { name: "zod" } }] }),
      () => ({ text: "zod object parsing uses z.object().parse [1]." }),
      // Re-dispatch: the rewritten question; the model repeats a search, which is refused.
      () => ({ text: '["zod object schema parse API reference"]' }),
      () => ({
        toolCalls: [{ id: "b", name: "find_library", arguments: { query: "zod" } }],
      }),
      () => ({ text: "zod object parsing: z.object [1]." }),
      // Merge.
      () => ({ text: "Parse with z.object [1]." }),
    ]);
    const r = await investigate(
      model,
      "Can we use zod?",
      {
        repoPath: process.cwd(),
        fetchJson: async () => ({ readme: "zod parses", license: "MIT" }),
        libraries: async (q: string) => {
          searched.push(q);
          return [];
        },
      },
      { maxItems: 1 },
    );
    // Dispatched twice, never a third time; still one host (npm), so uncovered.
    expect(r.coverage?.rounds).toBe(2);
    expect(r.coverage?.outstanding).toEqual(["zod object parsing"]);
    expect(r.coverage?.covered).toEqual([]);
    // The re-dispatch researched the rewritten question, not the first one again.
    expect(model.requests[4]?.messages?.[0]?.content).toMatch(
      /QUESTION\nzod object schema parse API reference/,
    );
    expect(searched).toEqual(["zod"]);
    expect(model.requests).toHaveLength(7);
  });

  it("closes a sub-question whose sources come from two independent hosts, with one dispatch", async () => {
    const { web } = pagesWeb();
    const model = scripted([
      () => ({ text: '["zod object parsing"]' }),
      () => ({
        toolCalls: [
          { id: "a", name: "package_readme", arguments: { name: "zod" } },
          { id: "b", name: "fetch_page", arguments: { url: "https://zod.dev/docs/objects" } },
        ],
      }),
      () => ({ text: "zod object parsing uses z.object().parse [1] [2]." }),
      () => ({ text: "Parse with z.object [1] [2]." }),
    ]);
    const r = await investigate(
      model,
      "Can we use zod?",
      { repoPath: process.cwd(), web, fetchJson: async () => ({ readme: "zod parses" }) },
      { maxItems: 1 },
    );
    expect(r.coverage?.rounds).toBe(1);
    expect(r.coverage?.covered).toEqual(["zod object parsing"]);
    expect(r.coverage?.outstanding).toEqual([]);
  });
});

describe("a search the sub-question already ran is refused (DS-N4-2)", () => {
  it("refuses the repeat before any request, so a re-dispatch uses different queries", async () => {
    const { budgetRefusal } = await import("../src/research/researcher.js");
    const deps = { repoPath: process.cwd(), queries: new Set<string>() };
    const call = { id: "1", name: "web_search", arguments: { query: "zod parse" } };
    expect(budgetRefusal(call, deps)).toBeUndefined();
    expect(budgetRefusal({ ...call, arguments: { query: "Zod Parse" } }, deps)).toMatch(
      /already ran for this sub-question/,
    );
  });
});

describe("effort with recorded caps (DS-N4-1)", () => {
  it("fixes sub-questions, pages per sub-question and verification depth per level", () => {
    expect(EFFORT_CAPS.quick.subQuestions).toBe(1);
    expect(EFFORT_CAPS.quick.critiqueCandidates).toBe(0);
    for (const k of ["subQuestions", "pagesPerSubQuestion", "critiqueCandidates"] as const) {
      expect(EFFORT_CAPS.standard[k]).toBeGreaterThanOrEqual(EFFORT_CAPS.quick[k]);
      expect(EFFORT_CAPS.exhaustive[k]).toBeGreaterThan(EFFORT_CAPS.standard[k]);
    }
    expect(effortOfLabels(["research", "effort:exhaustive"])).toBe("exhaustive");
    expect(effortOfLabels(["research"])).toBeUndefined();
  });

  it("refuses a page read past the sub-question's cap, before any request", async () => {
    const { web, fetched } = pagesWeb();
    const model = scripted([
      () => ({
        toolCalls: [
          { id: "a", name: "fetch_page", arguments: { url: "https://docs.example.test/a" } },
          { id: "b", name: "fetch_page", arguments: { url: "https://docs.example.test/b" } },
        ],
      }),
      () => ({ text: "It returns a record [1]." }),
    ]);
    await research(model, "What does parse return?", { repoPath: process.cwd(), web, maxPages: 1 });
    expect(fetched).toEqual(["https://docs.example.test/a"]);
    const tool = model.requests[1]?.messages?.filter((m) => m.role === "tool") ?? [];
    expect(tool[1]?.content).toMatch(/page budget for this sub-question \(1 page reads\) is spent/);
  });

  it("records the effort with the answer, on the ledger and in memory", async () => {
    const repo = tmp("effort-repo-");
    mkdirSync(join(repo, ".sekhemet"), { recursive: true });
    const db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    const memory = new ResearchMemory(join(tmp("effort-mem-"), "m.jsonl"));
    const model = scripted([
      () => ({ toolCalls: [{ id: "c1", name: "package_readme", arguments: { name: "zod" } }] }),
      () => ({ text: "Use z.object().parse [1]." }),
    ]);
    const service = new ResearchService({
      repoPath: repo,
      memory,
      log,
      tools: { fetchJson: async () => ({ readme: "zod docs", license: "MIT" }) },
      model: async () => model,
    });
    const r = await service.ask("How do I validate input with zod?", { effort: "quick" });
    expect(r.effort).toBe("quick");
    const [asked] = await log.getEventsByTypes(["research/asked"]);
    expect(asked?.payload).toMatchObject({ effort: "quick" });
    expect(memory.all()[0]?.effort).toBe("quick");
    db.close();
  });

  it("refuses exhaustive research while a card is running and offers the overnight window", async () => {
    const repo = tmp("effort-lease-");
    mkdirSync(join(repo, ".sekhemet"), { recursive: true });
    writeFileSync(
      leasePath(repo),
      JSON.stringify({ ...newLease(), kind: "run", cardId: "card_7" }),
    );
    const lines: string[] = [];
    const log = console.log;
    console.log = (l: string) => lines.push(String(l));
    try {
      const code = await runResearchCommand(
        ["What changed in zod 4?", "--effort", "exhaustive", "--offline"],
        repo,
      );
      expect(code).toBe(1);
    } finally {
      console.log = log;
    }
    const said = lines.join("\n");
    expect(said).toMatch(/card_7/);
    expect(said).toMatch(/overnight/);
  });
});

describe("the gated critique pass (DS-N2-6, DS-N2-7)", () => {
  const ledgerOf = () => {
    const ledger = new EvidenceLedger();
    ledger.noteRead({ kind: "documentation", ref: "https://csv.js.org/parse/" });
    ledger.noteRead({ kind: "forum", ref: "https://stackoverflow.com/q/9" });
    ledger.dates.set("https://csv.js.org/parse/", "2026-05-01");
    ledger.dates.set("https://stackoverflow.com/q/9", "2019-02-03");
    return ledger;
  };
  const draftOf = (text: string, ledger: EvidenceLedger) =>
    withClaims({
      answer: text,
      sources: [...ledger.read.keys()],
      evidence: [...ledger.read.values()],
      grounded: true,
      confidence: 0.5,
      badCitations: [3],
    });
  const REFS =
    "\n\nReferences:\n[1] https://csv.js.org/parse/\n[2] https://stackoverflow.com/q/9\n[3] https://nowhere.example/x";

  it("counts unreproduced executable claims in the risk, and keeps a draft a revision would make worse", () => {
    const risk = {
      badCitations: 1,
      uncovered: 0,
      failedClaims: 0,
      unreproduced: 1,
      confidence: 0.5,
    };
    expect(acceptRevision(risk, { ...risk, unreproduced: 2, badCitations: 0 }).accept).toBe(false);
    expect(acceptRevision(risk, { ...risk, unreproduced: 0 }).accept).toBe(true);
  });

  it("accepts a candidate that lowers badCitations and raises nothing, then stops when the next lowers nothing", async () => {
    const ledger = ledgerOf();
    const draft = draftOf(`Use csv-parse [1]. It is maintained [3].${REFS}`, ledger);
    const model = scripted([
      (req) => {
        expect(req.prompt).toMatch(/Citations that point at nothing read: \[3\]/);
        return {
          text: `Use csv-parse [1]. It is maintained [1].${REFS.replace(/\n\[3\].*$/, "")}`,
        };
      },
      // The second candidate measures the same: rejected, and the pass stops.
      () => ({ text: `Use csv-parse [1]. It is maintained [1].${REFS.replace(/\n\[3\].*$/, "")}` }),
      () => {
        throw new Error("the pass must stop when no candidate lowers the risk");
      },
    ]);
    const out = await critiquePass(model, "Which CSV parser?", draft, ledger, { candidates: 3 });
    expect(out.answer.badCitations).toEqual([]);
    expect(out.rounds.map((r) => r.accepted)).toEqual([true, false]);
    expect(out.rounds[1]?.reason).toMatch(/no measured improvement/);
    expect(model.requests).toHaveLength(2);
  });

  it("keeps the prior draft when a candidate adds an unreproduced executable claim", async () => {
    const ledger = ledgerOf();
    const draft = draftOf(`Use csv-parse [1]. It is maintained [3].${REFS}`, ledger);
    const model = scripted([
      () => ({
        text: `Use csv-parse [1]. The \`parse()\` function returns a stream of records [1].${REFS.replace(/\n\[3\].*$/, "")}`,
      }),
    ]);
    const out = await critiquePass(model, "Which CSV parser?", draft, ledger, { candidates: 1 });
    expect(out.answer.answer).toBe(draft.answer);
    expect(out.rounds[0]).toMatchObject({ accepted: false });
    expect(out.rounds[0]?.reason).toMatch(/unreproduced/);
  });

  it("reports both positions of a disagreement with tiers and dates, and names the better-supported one (DS-N2-8)", async () => {
    const ledger = ledgerOf();
    const parsed = parseDisagreements(
      "Answer [1].\nDISAGREEMENT: does parse stream? | it streams [1] | it buffers [2]\nDISAGREEMENT: bogus | a [7] | b [8]\n\nReferences:\n[1] https://csv.js.org/parse/\n[2] https://stackoverflow.com/q/9",
      ledger,
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ topic: "does parse stream?", betterSupported: "it streams" });
    const card = { id: "card_q", title: "CSV", labels: ["research"] } as never;
    const note = researchNote(card, {
      ...draftOf("Use csv-parse [1].", ledger),
      badCitations: [],
      disagreements: parsed,
    });
    expect(note).toMatch(/## Where sources disagree/);
    expect(note).toMatch(
      /it streams — documentation \(primary\), https:\/\/csv\.js\.org\/parse\/ \(2026-05-01\)/,
    );
    expect(note).toMatch(
      /it buffers — forum \(secondary\), https:\/\/stackoverflow\.com\/q\/9 \(2019-02-03\)/,
    );
    expect(note).toMatch(/Better supported: it streams, because/);
  });
});

describe("an executable claim documented but not run reaches Review (DS-N2-1, DS-N2-7)", () => {
  it("records it as documented, not reproduced, with the reason, and the claim gate passes", async () => {
    const repo = tmp("rdoc-");
    mkdirSync(join(repo, ".sekhemet"), { recursive: true });
    writeFileSync(join(repo, ".sekhemet", "gates.toml"), "[claims]\n");
    const db = new DatabaseSync(join(repo, "events.db"));
    initSchema(db);
    const cards = new CardStore(db, new EventLog(db));
    const board = new BoardServiceImpl(cards, {
      entryConditions: true,
      evidenceFor: (id) => ledgerEvidenceSummary(cards, repo, id),
    });
    const card = await cards.createCard({
      id: "card_q",
      tier: "task",
      title: "Which CSV parser should we use?",
      labels: ["research"],
      status: "ready",
    });
    const text =
      "Use csv-parse [1]. The `parse()` function returns a stream of records [1]. It has no citation `x()` returns y.\n\nReferences:\n[1] https://csv.js.org/parse/";
    const ledger = new EvidenceLedger();
    ledger.noteRead({ kind: "documentation", ref: "https://csv.js.org/parse/" });
    const { verifyReferences } = await import("../src/research/apodex_loop.js");
    const v = verifyReferences(text, ledger);
    const answer = withClaims({
      answer: text,
      sources: ["https://csv.js.org/parse/"],
      evidence: v.evidence,
      references: v.references,
      grounded: true,
      confidence: 0.6,
      badCitations: [],
    });
    const r = await runResearchCard(card, async () => answer, cards, repo, board);
    const report = JSON.parse(
      readFileSync(join(repo, ".sekhemet", "research", "card_q.claims.json"), "utf8"),
    );
    const executable = report.claims.filter((c: { kind: string }) => c.kind === "executable");
    expect(executable[0]).toMatchObject({
      text: "The `parse()` function returns a stream of records [1].",
      unreproducible: expect.stringMatching(
        /^documented, not reproduced: .*\[1\] https:\/\/csv\.js\.org\/parse\//,
      ),
    });
    // The uncited one has neither a run nor a reason: the gate names it and parks.
    expect(executable[1]?.unreproducible).toBeUndefined();
    expect(r.passed).toBe(false);
    const ev = JSON.parse(
      readFileSync(join(repo, ".sekhemet", "evidence", "latest-card_q.json"), "utf8"),
    );
    expect(ev.failures.map((f: { errorExcerpt: string }) => f.errorExcerpt)).toEqual([
      "[2] neither reproduced nor marked unreproducible with a reason",
    ]);

    // Once every executable claim is documented, the note reaches Review.
    const fine = withClaims({
      ...answer,
      answer: text.replace(" It has no citation `x()` returns y.", ""),
    });
    const card2 = await cards.createCard({
      id: "card_r",
      tier: "task",
      title: "Which CSV parser, again?",
      labels: ["research"],
      status: "ready",
    });
    const r2 = await runResearchCard(card2, async () => fine, cards, repo, board);
    expect(r2.passed).toBe(true);
    expect((await cards.getCard("card_r"))?.status).toBe("review");
    db.close();
  });
});
