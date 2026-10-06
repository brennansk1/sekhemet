import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReportedClaim } from "@sekhemet/gates";
import type { CardRecord } from "@sekhemet/kernel";
import type { InferenceRequest, InferenceResponse, LocalInferenceAdapter } from "@sekhemet/models";
import { ProcessSandbox } from "@sekhemet/sandbox";
import { afterEach, describe, expect, it } from "vitest";
import {
  EXTRACT_INFO_PROMPT,
  formatFetchResults,
  formatSearchResults,
  recencyFromTbs,
  splitSiteOperators,
  truncateMiddle,
} from "../src/research/apodex.js";
import { EvidenceLedger, asList, verifyReferences } from "../src/research/apodex_loop.js";
import { claimsReport } from "../src/research/cards.js";
import {
  PROBE_BUDGET,
  type ResearchAnswer,
  investigate,
  research,
  researchTools,
  runResearchTool,
  withClaims,
} from "../src/research/researcher.js";

/** A scripted Apodex: `main` answers the research turns, `extract` answers web_fetch extraction. */
function apodex(
  main: ((req: InferenceRequest) => Partial<InferenceResponse>)[],
  extract: (req: InferenceRequest) => string = () =>
    "EXTRACTED: DatabaseSync has exec(); use BEGIN/COMMIT/ROLLBACK.",
): LocalInferenceAdapter & { requests: InferenceRequest[] } {
  const requests: InferenceRequest[] = [];
  let i = 0;
  return {
    modelId: "apodex-1.1-mini",
    supportedArms: ["arm_a_flat"],
    nativeTools: true,
    contextWindow: { contextTokens: 16384, maxTokens: 1500 },
    requests,
    async generate(req) {
      requests.push(structuredClone(req));
      const usage = { promptTokens: 1, completionTokens: 1, durationMs: 1 };
      if (req.prompt.startsWith("You are given a piece of content")) {
        return { text: extract(req), toolCalls: [], usage };
      }
      const step = main[Math.min(i++, main.length - 1)] as (
        r: InferenceRequest,
      ) => Partial<InferenceResponse>;
      return { text: "", toolCalls: [], usage, ...step(req) };
    },
  };
}

/** Web access with a fake search engine and fake pages. */
function fakeWeb(pages: Record<string, string> = {}) {
  const searches: string[] = [];
  const fetch = async (url: string) => {
    if (url.startsWith("http://searx.test/search")) {
      const q = new URL(url).searchParams.get("q") ?? "";
      searches.push(q);
      return Response.json({
        results: [
          {
            title: "SQLite | Node.js Documentation",
            url: "https://nodejs.org/api/sqlite.html",
            content: "DatabaseSync class",
            engine: "yep",
          },
          {
            title: "SO answer",
            url: "https://stackoverflow.com/q/1",
            content: "use exec",
            engine: "stackexchange",
          },
        ],
      });
    }
    if (url.endsWith("/robots.txt")) return new Response("");
    const body = pages[url];
    return body
      ? new Response(body, { headers: { "content-type": "text/html" } })
      : new Response("", { status: 404 });
  };
  return { web: { fetch, searxngUrl: "http://searx.test" }, searches };
}

const PAGE = `<html><body><h1>SQLite</h1><p>${"The DatabaseSync class. ".repeat(40)} database.exec(sql) runs statements; use BEGIN, COMMIT and ROLLBACK for transactions.</p></body></html>`;

describe("Apodex's trained formats (FrontierAgent, Apache-2.0)", () => {
  it("formats search and fetch results exactly as the reference tools do", () => {
    expect(
      formatSearchResults([
        { title: "T", url: "https://a.dev", snippet: "s  x", date: "2026-01-02" },
      ]),
    ).toBe("[1] Title: T\n    Date: 2026-01-02\n    Snippet: s x\n    URL: https://a.dev");
    expect(formatSearchResults([])).toBe("No search results found.");
    expect(
      formatFetchResults([
        { url: "https://a.dev", info: "x" },
        { url: "https://b.dev", info: "y" },
      ]),
    ).toBe("[1] URL: https://a.dev\n    Info: x\n[2] URL: https://b.dev\n    Info: y");
    expect(EXTRACT_INFO_PROMPT("Q", "C")).toMatch(
      /INFORMATION TO EXTRACT:\nQ\n[\s\S]*CONTENT TO ANALYZE:\nC\n\nEXTRACTED INFORMATION:$/,
    );
  });

  it("reads list arguments in every shape the reference accepts", () => {
    expect(asList(["a", "b"])).toEqual(["a", "b"]);
    expect(asList('["a","b"]')).toEqual(["a", "b"]);
    expect(asList("a")).toEqual(["a"]);
    expect(asList(undefined)).toEqual([]);
  });

  it("maps tbs and site: operators, and truncates the middle", () => {
    expect(recencyFromTbs("qdr:w")).toBe("week");
    expect(recencyFromTbs(undefined)).toBeUndefined();
    expect(splitSiteOperators("sqlite wal site:sqlite.org -site:w3schools.com")).toEqual({
      query: "sqlite wal",
      site: ["sqlite.org"],
      exclude: ["w3schools.com"],
    });
    const t = truncateMiddle(`HEAD${"x".repeat(1000)}TAIL`, 100);
    expect(t.startsWith("HEAD")).toBe(true);
    expect(t.endsWith("TAIL")).toBe(true);
    expect(t).toMatch(/chars elided/);
  });
});

describe("the References contract", () => {
  it("accepts only sources whose text was read, flags orphans and search-only hits, and scores what was read (DS-N2-4)", () => {
    const ledger = new EvidenceLedger();
    ledger.seen.set("https://stackoverflow.com/q/1", "SO");
    ledger.noteRead({ kind: "documentation", ref: "https://nodejs.org/api/sqlite.html" });
    const v = verifyReferences(
      "Use exec [1]; also [2] and [3] and [4].\n\nReferences:\n[1] https://nodejs.org/api/sqlite.html\n[2] <https://stackoverflow.com/q/1>\n[3] https://made-up.example/x",
      ledger,
    );
    expect(v.references.map((r) => [r.n, r.read, r.known])).toEqual([
      [1, true, true],
      [2, false, true],
      [3, false, false],
    ]);
    // [2] was only a search hit: its page was never read, so it points at nothing read.
    expect(v.badCitations).toEqual([2, 3, 4]);
    expect(v.confidence).toBe(0.35); // documentation 0.35; a search-only hit counts for nothing
  });
});

describe("Apodex solo research (its ReAct mode)", () => {
  it("runs trained tools: parallel queries, fetch with extraction, finalize_answer; verifies References", async () => {
    const { web, searches } = fakeWeb({ "https://nodejs.org/api/sqlite.html": PAGE });
    const model = apodex([
      () => ({
        toolCalls: [
          {
            id: "a",
            name: "web_search",
            arguments: { q: ["node:sqlite transaction", "DatabaseSync exec site:nodejs.org"] },
          },
        ],
      }),
      () => ({
        toolCalls: [
          {
            id: "b",
            name: "web_fetch",
            arguments: {
              url: "https://nodejs.org/api/sqlite.html",
              info_to_extract: "How to run a transaction",
            },
          },
        ],
      }),
      () => ({
        toolCalls: [
          {
            id: "c",
            name: "finalize_answer",
            arguments: {
              content:
                "Call db.exec('BEGIN') ... COMMIT, ROLLBACK on error [1].\n\nReferences:\n[1] https://nodejs.org/api/sqlite.html",
              confidence: 0.8,
            },
          },
        ],
      }),
    ]);
    const r = await research(model, "How do I run a transaction with node:sqlite?", {
      repoPath: process.cwd(),
      web,
      today: "2026-09-18",
    });
    // Both queries ran; the site: operator became a filter, not literal text.
    expect(searches).toEqual(["node:sqlite transaction", "DatabaseSync exec site:nodejs.org"]);
    const first = model.requests[0] as InferenceRequest;
    expect(first.systemPrompt).toMatch(/^You are a versatile research agent/);
    expect(first.systemPrompt).toMatch(/Today's date \(UTC\): 2026-09-18/);
    expect(first.tools?.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        "web_search",
        "web_fetch",
        "scholar_search",
        "read_docs",
        "finalize_answer",
      ]),
    );
    // The search result reached the model in the trained format.
    // Web results arrive in the trained format, inside the untrusted wrapper (X8).
    const unwrap = (t?: string) =>
      t?.replace(/^<untrusted source="[^"]+">\n/, "").replace(/\n<\/untrusted>$/, "");
    const searchTurn = model.requests[1]?.messages?.find((m) => m.role === "tool");
    expect(unwrap(searchTurn?.content)).toMatch(
      /^\[1\] Title: SQLite \| Node\.js Documentation\n {4}Snippet: DatabaseSync class\n {4}URL: https:\/\/nodejs\.org\/api\/sqlite\.html/,
    );
    // web_fetch ran the reference extraction prompt and returned [N] URL / Info.
    const extraction = model.requests.find((q) =>
      q.prompt.startsWith("You are given a piece of content"),
    );
    expect(extraction?.prompt).toMatch(/INFORMATION TO EXTRACT:\nHow to run a transaction/);
    expect(extraction?.reasoning).toBe("off");
    const fetchTurn = model.requests[3]?.messages?.filter((m) => m.role === "tool").at(-1);
    expect(unwrap(fetchTurn?.content)).toBe(
      "[1] URL: https://nodejs.org/api/sqlite.html\n    Info: EXTRACTED: DatabaseSync has exec(); use BEGIN/COMMIT/ROLLBACK.",
    );
    expect(r.grounded).toBe(true);
    expect(r.badCitations).toEqual([]);
    expect(r.sources).toEqual(["https://nodejs.org/api/sqlite.html"]);
    expect(r.confidence).toBe(0.35);
  });

  it("refuses a duplicate search, nudges a text-only turn once, and forces finalize at the budget", async () => {
    const { web } = fakeWeb();
    const model = apodex([
      () => ({ toolCalls: [{ id: "a", name: "web_search", arguments: { q: "sqlite wal" } }] }),
      () => ({ toolCalls: [{ id: "b", name: "web_search", arguments: { q: "SQLite WAL" } }] }),
      () => ({ text: "I think WAL is good." }),
      () => ({ toolCalls: [{ id: "c", name: "web_search", arguments: { q: "wal checkpoint" } }] }),
      (req) => ({
        toolCalls:
          req.tools?.length === 1
            ? [
                {
                  id: "d",
                  name: "finalize_answer",
                  arguments: { content: "Not settled: only snippets." },
                },
              ]
            : [],
      }),
    ]);
    const r = await research(model, "WAL?", { repoPath: process.cwd(), web, maxRounds: 5 });
    const tools = model.requests
      .flatMap((q) => q.messages ?? [])
      .filter((m) => m.role === "tool")
      .map((m) => m.content);
    expect(tools.some((t) => /This exact search already ran/.test(t))).toBe(true);
    const users =
      model.requests
        .at(-1)
        ?.messages?.filter((m) => m.role === "user")
        .map((m) => m.content) ?? [];
    expect(users.some((u) => /If you are done, call finalize_answer/.test(u))).toBe(true);
    expect(users.at(-1)).toMatch(/Turn budget reached/);
    expect(model.requests.at(-1)?.tools?.map((t) => t.name)).toEqual(["finalize_answer"]);
    expect(r.grounded).toBe(false);
  });

  it("compacts old tool results with the trained marker once past the budget", async () => {
    const { web } = fakeWeb({ "https://nodejs.org/api/sqlite.html": PAGE });
    const long = "Z".repeat(20000);
    const model = apodex(
      [
        () => ({
          toolCalls: [
            {
              id: "a",
              name: "web_fetch",
              arguments: { url: "https://nodejs.org/api/sqlite.html", info_to_extract: "x" },
            },
          ],
        }),
        () => ({
          toolCalls: [
            {
              id: "b",
              name: "web_fetch",
              arguments: { url: "https://nodejs.org/api/sqlite.html", info_to_extract: "y" },
            },
          ],
        }),
        () => ({
          toolCalls: [
            {
              id: "c",
              name: "web_fetch",
              arguments: { url: "https://nodejs.org/api/sqlite.html", info_to_extract: "z" },
            },
          ],
        }),
        // The budget is the allocator's Researcher budget (CX-N3-3), a little
        // larger than the old fixed 7,000-token reserve: one more result passes it.
        () => ({
          toolCalls: [
            {
              id: "c2",
              name: "web_fetch",
              arguments: { url: "https://nodejs.org/api/sqlite.html", info_to_extract: "w" },
            },
          ],
        }),
        () => ({
          toolCalls: [{ id: "d", name: "finalize_answer", arguments: { content: "done" } }],
        }),
      ],
      () => long,
    );
    await research(model, "q", { repoPath: process.cwd(), web });
    const lastMsgs =
      model.requests.filter((q) => !q.prompt.startsWith("You are given")).at(-1)?.messages ?? [];
    expect(
      lastMsgs
        .filter((m) => m.role === "tool")
        .some((m) => m.content.startsWith("[context compacted]")),
    ).toBe(true);
  });
});

describe("Apodex Agent Team (deep research)", () => {
  it("coordinator creates agents, assigns tasks, collects Scope/Findings reports, and merges with verified References", async () => {
    const SOURCE = "https://github.com/nodejs/node/blob/main/doc/api/sqlite.md";
    const { web } = fakeWeb({ "https://nodejs.org/api/sqlite.html": PAGE, [SOURCE]: PAGE });
    let subCalls = 0;
    const model = apodex([
      // Coordinator: create and assign.
      () => ({
        toolCalls: [
          {
            id: "1",
            name: "create_subagent",
            arguments: {
              agents: [
                { name: "docs_researcher", system_prompt: "Official docs" },
                { name: "final_verifier" },
              ],
            },
          },
          {
            id: "2",
            name: "assign_task",
            arguments: {
              tasks: [
                { agent: "docs_researcher", prompt: "Find the node:sqlite transaction API." },
              ],
            },
          },
        ],
      }),
      // Coordinator: collect (runs the sub-agent).
      () => ({ toolCalls: [{ id: "3", name: "collect_reports", arguments: {} }] }),
      // Sub-agent turn 1: fetch.
      (req) => {
        subCalls++;
        expect(req.systemPrompt).toMatch(/^You are an expert problem-solving sub-agent/);
        expect(req.systemPrompt).toMatch(/# Your role\nOfficial docs/);
        return {
          toolCalls: [
            {
              id: "s1",
              name: "web_fetch",
              arguments: {
                url: "https://nodejs.org/api/sqlite.html",
                info_to_extract: "transactions",
              },
            },
          ],
        };
      },
      // Sub-agent turn 2: submit_report.
      () => ({
        toolCalls: [
          {
            id: "s2",
            name: "submit_report",
            arguments: {
              content:
                "Scope: API\nFindings: exec('BEGIN') ... COMMIT (RETRIEVED)\nEvidence:\n  - https://nodejs.org/api/sqlite.html — exec runs statements — quality: high\nConfidence: high",
              confidence: 0.9,
            },
          },
        ],
      }),
      // One host (nodejs.org) leaves the sub-question open: it is dispatched
      // once more, told which host it had, and reads a second one (DS-N4-2).
      (req) => {
        expect(req.messages?.[0]?.content).toMatch(
          /still open: .*its sources so far come only from nodejs\.org/,
        );
        return {
          toolCalls: [
            { id: "r1", name: "web_fetch", arguments: { url: SOURCE, info_to_extract: "exec" } },
          ],
        };
      },
      () => ({
        toolCalls: [
          {
            id: "r2",
            name: "submit_report",
            arguments: {
              content: `Scope: API source\nFindings: exec in ${SOURCE}\nConfidence: high`,
            },
          },
        ],
      }),
      // Coordinator: final plain-text answer.
      (req) => {
        const last = req.messages?.at(-1);
        expect(last?.role).toBe("tool");
        expect(last?.content).toMatch(/^<report agent="docs_researcher">\nScope: API/);
        return {
          text: "Use exec('BEGIN') then COMMIT [1].\n\nReferences:\n[1] https://nodejs.org/api/sqlite.html",
        };
      },
    ]);
    const r = await investigate(model, "Transactions in node:sqlite?", {
      repoPath: process.cwd(),
      web,
      today: "2026-09-18",
    });
    expect(subCalls).toBe(1);
    expect(model.requests[0]?.systemPrompt).toMatch(/You are a coordinator/);
    expect(model.requests[0]?.tools?.map((t) => t.name)).toEqual([
      "create_subagent",
      "assign_task",
      "collect_reports",
    ]);
    expect(r.answer).toMatch(/^Use exec/);
    expect(r.grounded).toBe(true);
    expect(r.badCitations).toEqual([]);
    expect(r.coverage?.items).toBe(1);
    expect(r.coverage?.covered).toEqual(["Find the node:sqlite transaction API."]);
    expect(r.coverage?.outstanding).toEqual([]);
  });

  it("reports a sub-question uncovered when its re-dispatch still reads one host (DS-N4-2)", async () => {
    const { web } = fakeWeb({ "https://nodejs.org/api/sqlite.html": PAGE });
    const fetchDocs = () => ({
      toolCalls: [
        {
          id: "f",
          name: "web_fetch",
          arguments: { url: "https://nodejs.org/api/sqlite.html", info_to_extract: "x" },
        },
      ],
    });
    const submit = () => ({
      toolCalls: [{ id: "s", name: "submit_report", arguments: { content: "Findings: exec" } }],
    });
    const model = apodex([
      () => ({
        toolCalls: [
          {
            id: "1",
            name: "assign_task",
            arguments: { tasks: [{ agent: "docs", prompt: "Find the transaction API." }] },
          },
        ],
      }),
      () => ({ toolCalls: [{ id: "2", name: "collect_reports", arguments: {} }] }),
      fetchDocs,
      submit,
      fetchDocs,
      submit,
      () => ({
        text: "Use exec [1].\n\nReferences:\n[1] https://nodejs.org/api/sqlite.html",
      }),
    ]);
    const r = await investigate(model, "Transactions?", { repoPath: process.cwd(), web });
    expect(r.coverage?.outstanding).toEqual(["Find the transaction API."]);
    expect(r.coverage?.covered).toEqual([]);
    expect(r.coverage?.coveragePct).toBe(0);
    expect(r.answer).toMatch(/^Use exec/);
  });

  it("will not answer while tasks are assigned but uncollected, and bounds the team", async () => {
    const { web } = fakeWeb();
    const model = apodex([
      () => ({
        toolCalls: [
          {
            id: "1",
            name: "assign_task",
            arguments: {
              tasks: [1, 2, 3, 4, 5, 6].map((n) => ({ agent: `a${n}`, prompt: `task ${n}` })),
            },
          },
        ],
      }),
      () => ({ text: "premature answer" }),
      () => ({ text: "final [1]\n\nReferences:\n[1] https://nowhere.example" }),
    ]);
    const r = await investigate(model, "q", { repoPath: process.cwd(), web }, { maxItems: 2 });
    const assignOut = model.requests[1]?.messages?.find((m) => m.role === "tool")?.content;
    expect(assignOut).toMatch(/Assigned 2 task\(s\)/); // capped at 2 agents
    expect(model.requests[2]?.messages?.at(-1)?.content).toMatch(
      /Call collect_reports before answering/,
    );
    expect(r.badCitations).toEqual([1]); // a URL no tool returned
    expect(r.grounded).toBe(false);
  });
});

describe("reasoning never leaks into answers", () => {
  it("drops everything up to the last </think>, even when the opening tag was in the prompt", async () => {
    // R-50: the one reader, `stripReasoning`, with no wrapper of its own here.
    const { stripReasoning } = await import("@sekhemet/models");
    expect(stripReasoning("planning... </think>\n\nThe answer.")).toBe("The answer.");
    expect(stripReasoning("<think>a</think>B")).toBe("B");
    expect(stripReasoning("Plain.")).toBe("Plain.");
    expect(stripReasoning("Answer <think>unfinished")).toBe("Answer");
  });
});

describe("server slots", () => {
  it("keeps the conversation on slot 0 and extraction on slot 1", async () => {
    const { research } = await import("../src/research/researcher.js");
    const page = `<html><body><p>${"content ".repeat(100)}</p></body></html>`;
    const web = {
      fetch: async (url: string) =>
        url.endsWith("/robots.txt")
          ? new Response("")
          : new Response(page, { headers: { "content-type": "text/html" } }),
    };
    const requests: { slot?: number; extraction: boolean }[] = [];
    let i = 0;
    const steps = [
      {
        toolCalls: [
          {
            id: "a",
            name: "web_fetch",
            arguments: { url: "https://docs.example.dev/a", info_to_extract: "x" },
          },
        ],
      },
      { toolCalls: [{ id: "b", name: "finalize_answer", arguments: { content: "done" } }] },
    ];
    const model = {
      modelId: "apodex-1.1-mini",
      supportedArms: ["arm_a_flat" as const],
      nativeTools: true,
      async generate(req: { prompt: string; slot?: number }) {
        const extraction = req.prompt.startsWith("You are given a piece of content");
        requests.push({ ...(req.slot !== undefined ? { slot: req.slot } : {}), extraction });
        const usage = { promptTokens: 1, completionTokens: 1, durationMs: 1 };
        return extraction
          ? { text: "info", toolCalls: [], usage }
          : { text: "", usage, ...steps[i++] };
      },
    };
    await research(model as never, "q", { repoPath: process.cwd(), web });
    expect(requests.filter((r) => r.extraction).every((r) => r.slot === 1)).toBe(true);
    expect(requests.filter((r) => !r.extraction).every((r) => r.slot === 0)).toBe(true);
    expect(requests.some((r) => r.extraction)).toBe(true);
  });
});

describe("citation repair", () => {
  it("rejects a finalize that cites an unreturned URL once, then accepts the repaired answer", async () => {
    const page = `<html><body><p>${"real docs ".repeat(60)}</p></body></html>`;
    const web = {
      fetch: async (url: string) =>
        url.endsWith("/robots.txt")
          ? new Response("")
          : new Response(page, { headers: { "content-type": "text/html" } }),
    };
    const seen: string[] = [];
    let i = 0;
    const steps = [
      {
        toolCalls: [
          {
            id: "a",
            name: "web_fetch",
            arguments: { url: "https://docs.example.dev/a", info_to_extract: "x" },
          },
        ],
      },
      {
        toolCalls: [
          {
            id: "b",
            name: "finalize_answer",
            arguments: {
              content:
                "X [1] and Y [2].\n\nReferences:\n[1] https://docs.example.dev/a\n[2] https://invented.example/z",
            },
          },
        ],
      },
      {
        toolCalls: [
          {
            id: "c",
            name: "finalize_answer",
            arguments: { content: "X [1].\n\nReferences:\n[1] https://docs.example.dev/a" },
          },
        ],
      },
    ];
    const model = {
      modelId: "apodex-1.1-mini",
      supportedArms: ["arm_a_flat" as const],
      nativeTools: true,
      async generate(req: { prompt: string; messages?: { role: string; content: string }[] }) {
        const usage = { promptTokens: 1, completionTokens: 1, durationMs: 1 };
        if (req.prompt.startsWith("You are given a piece of content"))
          return { text: "info", toolCalls: [], usage };
        const last = req.messages?.at(-1);
        if (last) seen.push(last.content);
        return { text: "", usage, ...steps[i++] };
      },
    };
    const r = await research(model as never, "q", { repoPath: process.cwd(), web });
    expect(seen.some((c) => /finalize_answer rejected: citation\(s\) \[2\]/.test(c))).toBe(true);
    expect(r.answer).toBe("X [1].\n\nReferences:\n[1] https://docs.example.dev/a");
    expect(r.badCitations).toEqual([]);
    expect(r.grounded).toBe(true);
  });
});

describe("papers as sources", () => {
  it("counts a scholar_search hit as a read paper and accepts a reference by its title", async () => {
    const web = {
      fetch: async (url: string) => {
        if (url.includes("huggingface.co/api/papers/search")) {
          return Response.json([
            {
              paper: { id: "2105.01234", upvotes: 3 },
              title:
                "Assessing the Risk of Software Development in Agile Methodologies Using Simulation",
              summary:
                "We build a Monte Carlo simulation over empirical throughput to forecast release dates with confidence intervals, and compare it with velocity-based planning.",
              publishedAt: "2021-05-01",
            },
          ]);
        }
        return new Response("", { status: 404 });
      },
    };
    const model = apodex([
      () => ({
        toolCalls: [
          {
            id: "a",
            name: "scholar_search",
            arguments: { query: "monte carlo throughput forecasting" },
          },
        ],
      }),
      () => ({
        toolCalls: [
          {
            id: "b",
            name: "finalize_answer",
            arguments: {
              content:
                "Forecast with Monte Carlo over throughput [1].\n\nReferences:\n[1] Lunesu et al. (2021), Assessing the risk of software development in agile methodologies using simulation.",
            },
          },
        ],
      }),
    ]);
    const r = await research(model, "How should a small team forecast delivery?", {
      repoPath: process.cwd(),
      web,
    });
    expect(r.badCitations).toEqual([]);
    expect(r.grounded).toBe(true);
    expect(r.evidence[0]).toMatchObject({ kind: "paper", ref: "https://arxiv.org/abs/2105.01234" });
    expect(r.confidence).toBe(0.25);
  });
});

describe("the Researcher's probe tool (DS-N9-13)", () => {
  const confines = new ProcessSandbox({ engine: "native" }).confinement !== "none";
  const made: string[] = [];
  afterEach(() => {
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  /** A project with one installed CommonJS package. */
  function project(): string {
    const repo = mkdtempSync(join(tmpdir(), "probe-tool-"));
    made.push(repo);
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ name: "app", dependencies: { "cjs-calc": "1.0.0" } }),
    );
    const pkg = join(repo, "node_modules", "cjs-calc");
    mkdirSync(join(pkg, "lib"), { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "cjs-calc", version: "1.0.0", main: "lib/index.js" }),
    );
    writeFileSync(join(pkg, "lib", "index.js"), "exports.add = (a, b) => a + b;\n");
    return repo;
  }
  const probeCall = (code: string, pkg = "cjs-calc") => ({
    id: "p1",
    name: "probe",
    arguments: { package: pkg, language: "node", code, statement: "add sums two numbers" },
  });

  it("is offered to both pipelines, with a budget per effort of 2, 4 and 6", () => {
    expect(researchTools(false).map((t) => t.name)).toContain("probe");
    expect(PROBE_BUDGET).toEqual({ quick: 2, standard: 4, exhaustive: 6 });
  });

  it("refuses a probe past the budget, an uninstalled package and the brief's deep question, before running", async () => {
    const repo = project();
    const spent = await runResearchTool(probeCall("console.log(1)"), {
      repoPath: repo,
      probeBudget: { max: 2, used: 2 },
    });
    expect(spent.text).toMatch(/probe budget.*\(2 probes\) is spent/i);
    expect(spent.source).toBeUndefined();
    const missing = await runResearchTool(probeCall("console.log(1)", "left-pad"), {
      repoPath: repo,
      probeBudget: { max: 2, used: 0 },
    });
    expect(missing.text).toMatch(/left-pad has no installed copy/);
    const off = await runResearchTool(probeCall("console.log(1)"), {
      repoPath: repo,
      repository: false,
    });
    expect(off.text).toMatch(/off for this question/);
  });

  it.runIf(confines)(
    "runs a probe in the sandbox; one that exits 0 adds its executable claim to the claims report",
    async () => {
      const repo = project();
      const probeClaims: ReportedClaim[] = [];
      const budget = { max: 2, used: 0 };
      const ok = await runResearchTool(
        probeCall(
          'const { add } = require("cjs-calc");\nif (add(2, 3) !== 5) process.exit(1);\nconsole.log("sum", add(2, 3));',
        ),
        { repoPath: repo, probeBudget: budget, probeClaims },
      );
      expect(budget.used).toBe(1);
      expect(ok.text).toMatch(/exit 0/);
      expect(ok.text).toMatch(/<untrusted source="probe">\nsum 5/);
      expect(ok.source?.ref).toMatch(/^probe cjs-calc@1\.0\.0 [0-9a-f]{12}$/);
      expect(probeClaims).toHaveLength(1);
      expect(probeClaims[0]).toMatchObject({ kind: "executable" });
      expect(probeClaims[0]?.reproduce?.code).toMatch(/require\("cjs-calc"\)/);

      const failed = await runResearchTool(probeCall("process.exit(3);"), {
        repoPath: repo,
        probeBudget: budget,
        probeClaims,
      });
      expect(failed.text).toMatch(/exit 3/);
      expect(probeClaims).toHaveLength(1);

      const answer: ResearchAnswer = {
        ...withClaims({
          answer: "It sums [1].",
          sources: [],
          evidence: [],
          grounded: true,
          confidence: 0.5,
          badCitations: [],
        }),
        probeClaims,
      };
      const report = JSON.parse(claimsReport({ id: "c1" } as CardRecord, answer)) as {
        claims: ReportedClaim[];
      };
      expect(report.claims.some((c) => c.reproduce?.code.includes("cjs-calc"))).toBe(true);
    },
  );

  it.runIf(confines)(
    "a packet question's probe reads the dependencies, never the project (DS-N9-17)",
    async () => {
      const repo = project();
      mkdirSync(join(repo, "src"));
      writeFileSync(join(repo, "src", "secret.ts"), "export const key = 'SECRET_FROM_PROJECT';\n");
      const r = await runResearchTool(
        probeCall(
          `const { add } = require("cjs-calc");\nlet seen = "unread";\ntry { seen = require("node:fs").readFileSync(${JSON.stringify(join(repo, "src", "secret.ts"))}, "utf8"); } catch (e) { seen = e.code; }\nconsole.log(add(2, 3), seen);`,
        ),
        { repoPath: repo, repository: "dependencies", probeBudget: { max: 2, used: 0 } },
      );
      expect(r.text).toMatch(/exit 0/);
      expect(r.text).not.toContain("SECRET_FROM_PROJECT");
      expect(r.text).toMatch(/5 (EPERM|EACCES|ENOENT)/);
    },
  );
});
