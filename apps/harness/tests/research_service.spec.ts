import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InferenceRequest, InferenceResponse, LocalInferenceAdapter } from "@sekhemet/models";
import { describe, expect, it } from "vitest";
import { docRoot, readDocs, sitemapUrls } from "../src/research/docs.js";
import { runResearchLoop } from "../src/research/loop.js";
import {
  type Clock,
  HostPacer,
  PoliteFetcher,
  ResearchCache,
  parseRobots,
  robotsAllows,
} from "../src/research/polite.js";
import {
  apodexSystemPrompt,
  checkCitations,
  investigate,
  maskOldEvidence,
  research,
} from "../src/research/researcher.js";
import { groundingConfidence, isCovered, kindOfUrl, rankHits } from "../src/research/sources.js";
import { invertedAbstract, paperCitations, readPaper } from "../src/research/web.js";

const fakeClock = (): Clock & { slept: number[]; t: number } => {
  const c = {
    t: 0,
    slept: [] as number[],
    now: () => c.t,
    sleep: async (ms: number) => {
      c.slept.push(ms);
      c.t += ms;
    },
  };
  return c;
};

describe("polite access (ported from Helga's ratelimit and doc_fetch)", () => {
  it("paces arXiv at its documented 3 s and queues concurrent callers", async () => {
    const clock = fakeClock();
    const pacer = new HostPacer(clock);
    await Promise.all([
      pacer.wait("https://export.arxiv.org/api/query?a"),
      pacer.wait("https://export.arxiv.org/api/query?b"),
      pacer.wait("https://export.arxiv.org/api/query?c"),
    ]);
    // First call free, then one 3 s slot each: the third starts at t = 6 s.
    expect(clock.slept).toEqual([3000, 3000]);
    expect(clock.t).toBe(6000);
    // A different host shares no budget.
    expect(await pacer.wait("https://api.openalex.org/works")).toBe(0);
  });

  it("backs off on 429 Retry-After and adapts to X-Rate-Limit headers", async () => {
    const clock = fakeClock();
    const pacer = new HostPacer(clock);
    pacer.note("https://api.crossref.org/x", 429, new Headers({ "retry-after": "20" }));
    expect(pacer.isBlocked("https://api.crossref.org/y")).toBe(true);
    expect(await pacer.wait("https://api.crossref.org/y")).toBe(20_000);
    pacer.note(
      "https://api.crossref.org/x",
      200,
      new Headers({ "x-rate-limit-limit": "50", "x-rate-limit-interval": "1s" }),
    );
    expect(pacer.intervalFor("api.crossref.org")).toBeCloseTo(0.02);
  });

  it("reads robots.txt: own group first, longest match, Allow on ties, Crawl-delay", () => {
    const text = [
      "User-agent: *",
      "Disallow: /private",
      "Crawl-delay: 4",
      "",
      "User-agent: Sekhemet-Researcher",
      "Disallow: /search",
      "Allow: /search/about$",
    ].join("\n");
    const own = parseRobots(text, "Sekhemet-Researcher/1.1 (x)");
    expect(robotsAllows(own, "/search?q=1")).toBe(false);
    expect(robotsAllows(own, "/search/about")).toBe(true);
    expect(robotsAllows(own, "/private")).toBe(true); // our group does not forbid it
    const other = parseRobots(text, "SomethingElse");
    expect(robotsAllows(other, "/private/x")).toBe(false);
    expect(other.delayS).toBe(4);
    expect(robotsAllows(parseRobots("", "x"), "/anything")).toBe(true); // fail open
  });

  it("refuses private hosts, obeys robots for page reads, caches GETs, retries once on 429", async () => {
    const calls: string[] = [];
    let limited = true;
    const fetchFn = async (url: string) => {
      calls.push(url);
      if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nDisallow: /secret");
      if (url.includes("/limited")) {
        if (limited) {
          limited = false;
          return new Response("slow down", { status: 429, headers: { "retry-after": "1" } });
        }
        return new Response("ok now");
      }
      return new Response(`page ${url}`, { headers: { "content-type": "text/html" } });
    };
    const clock = fakeClock();
    const pf = new PoliteFetcher({
      fetch: fetchFn,
      pacer: new HostPacer(clock),
      cache: new ResearchCache(mkdtempSync(join(tmpdir(), "rc-"))),
    });
    await expect(pf.fetch("http://192.168.1.4/x")).rejects.toThrow(/private/);
    expect((await pf.fetch("https://example.com/secret/a", {}, true)).status).toBe(451);
    expect(await (await pf.fetch("https://example.com/open", {}, true)).text()).toContain("page");
    const before = calls.length;
    expect(await (await pf.fetch("https://example.com/open", {}, true)).text()).toContain("page");
    expect(calls.length).toBe(before); // served from the cache
    expect(await (await pf.fetch("https://example.com/limited")).text()).toBe("ok now");
    expect(clock.slept).toContain(1000);
    expect(pf.stats.cached).toBe(1);
    expect(pf.stats.blocked).toBe(1);
  });
});

describe("sources and grounding (ported from Helga's ranking)", () => {
  it("classifies URLs and ranks official docs first, content farms out", () => {
    expect(kindOfUrl("https://nodejs.org/api/sqlite.html")).toBe("documentation");
    expect(kindOfUrl("https://docs.pytest.org/en/stable/")).toBe("documentation");
    expect(kindOfUrl("https://arxiv.org/abs/2605.03042")).toBe("paper");
    expect(kindOfUrl("https://github.com/a/b/blob/main/x.ts")).toBe("source");
    expect(kindOfUrl("https://stackoverflow.com/q/1")).toBe("forum");
    const ranked = rankHits([
      { url: "https://www.geeksforgeeks.org/sqlite" },
      { url: "https://someblog.dev/sqlite" },
      { url: "https://stackoverflow.com/q/1" },
      { url: "https://nodejs.org/api/sqlite.html" },
      { url: "https://nodejs.org/api/sqlite.html#x" },
    ]);
    expect(ranked.map((r) => r.url)).toEqual([
      "https://nodejs.org/api/sqlite.html",
      "https://stackoverflow.com/q/1",
      "https://someblog.dev/sqlite",
    ]);
  });

  it("caps families so a pile of posts never outscores the documentation", () => {
    const posts = Array.from({ length: 9 }, (_, i) => ({ kind: "web", ref: `p${i}` }));
    const docs = [
      { kind: "documentation", ref: "d" },
      { kind: "api", ref: "a" },
    ];
    expect(groundingConfidence(posts)).toBe(0.3);
    expect(groundingConfidence(docs)).toBe(0.7);
    expect(
      groundingConfidence([...docs, { kind: "paper", ref: "x" }, { kind: "source", ref: "s" }]),
    ).toBe(1);
    // An unregistered kind is small, never zero.
    expect(groundingConfidence([{ kind: "podcast", ref: "q" }])).toBe(0.1);
    // Duplicates count once.
    expect(
      groundingConfidence([
        { kind: "paper", ref: "x" },
        { kind: "paper", ref: "x" },
      ]),
    ).toBe(0.25);
  });

  it("measures coverage on the topic, not the model's explanation of it", () => {
    expect(
      isCovered(
        "DatabaseSync transactions: how BEGIN and COMMIT work",
        "use DatabaseSync; exec('BEGIN') ... transactions",
      ),
    ).toBe(true);
    expect(isCovered("Vitest fake timers", "jest mocks only")).toBe(false);
  });
});

describe("documentation reader (ported from Helga's doc_reader)", () => {
  const site: Record<string, string> = {
    "https://docs.example.dev/robots.txt": "Sitemap: https://docs.example.dev/sm-index.xml",
    "https://docs.example.dev/sm-index.xml":
      "<sitemapindex><sitemap><loc>https://docs.example.dev/sm1.xml</loc></sitemap></sitemapindex>",
    "https://docs.example.dev/sm1.xml": `<urlset>${[
      "about/a",
      "about/b",
      "about/c",
      "api/transactions",
      "api/statements",
      "guide/start",
    ]
      .map((p) => `<url><loc>https://docs.example.dev/docs/${p}</loc></url>`)
      .join("")}<url><loc>https://blog.example.dev/x</loc></url></urlset>`,
  };
  const page = (title: string, body: string) =>
    `<html><title>${title}</title><body><p>${body} ${"filler text ".repeat(40)}</p><pre>code</pre></body></html>`;
  site["https://docs.example.dev/docs/api/transactions"] = page(
    "Transactions",
    "Use BEGIN and COMMIT; transactions roll back on error. transactions transactions",
  );
  site["https://docs.example.dev/docs/api/statements"] = page("Statements", "Prepared statements");
  site["https://docs.example.dev/docs/guide/start"] = page("Start", "Install it");
  const fetchText = async (u: string) => site[u];

  it("enumerates by sitemap index, keeps to the docs root, interleaves sections", async () => {
    expect(docRoot("https://docs.example.dev/docs/guide/start")).toBe(
      "https://docs.example.dev/docs/",
    );
    const urls = await sitemapUrls("https://docs.example.dev/docs/guide/start", fetchText);
    expect(urls).toHaveLength(6);
    expect(urls.some((u) => u.includes("blog."))).toBe(false);
    // Round-robin: the first three URLs come from three different sections.
    expect(new Set(urls.slice(0, 3).map((u) => u.split("/docs/")[1]?.split("/")[0])).size).toBe(3);
  });

  it("reads the pages that answer the question, best first", async () => {
    const r = await readDocs(
      "https://docs.example.dev/docs/guide/start",
      "how do transactions commit",
      fetchText,
    );
    if (typeof r === "string") throw new Error(r);
    expect(r.available).toBe(6);
    expect(r.pages[0]?.title).toBe("Transactions");
    expect(r.pages[0]?.codeBlocks).toBe(1);
    expect(await readDocs("nosuchlib", "x", fetchText)).toMatch(/No known documentation/);
  });
});

describe("papers", () => {
  it("rebuilds OpenAlex abstracts and snowballs citations", async () => {
    expect(invertedAbstract({ world: [1], hello: [0], again: [2] })).toBe("hello world again");
    const fetch = async (url: string) => {
      if (url.includes("works/doi:10.48550/arXiv.2605.03042")) {
        return Response.json({ id: "https://openalex.org/W9", referenced_works: [] });
      }
      if (url.includes("filter=cites:W9")) {
        return Response.json({
          results: [
            {
              id: "https://openalex.org/W1",
              title: "A follow-up",
              doi: "https://doi.org/10.48550/arxiv.2607.00001",
              publication_year: 2026,
              cited_by_count: 12,
              abstract_inverted_index: { Builds: [0], on: [1], ARIS: [2] },
            },
          ],
        });
      }
      return new Response("", { status: 404 });
    };
    const hits = await paperCitations("2605.03042", "cited_by", { fetch });
    expect(Array.isArray(hits) && hits[0]?.url).toBe("https://arxiv.org/abs/2607.00001");
    expect(Array.isArray(hits) && hits[0]?.snippet).toBe("Builds on ARIS");
    expect(await paperCitations("2605.03042", "references", { fetch })).toMatch(/no references/);
    expect(await paperCitations("nonsense", "references", { fetch })).toMatch(/Give an arXiv id/);
  });

  it("returns a paper's section outline first, then a section by heading", async () => {
    const html = `<html><body><h1>Title</h1><p>${"intro ".repeat(300)}</p><h2>3 Method</h2><p>The method is X.</p><h2>4 Results</h2><p>It works.</p></body></html>`;
    const fetch = async () => new Response(html, { headers: { "content-type": "text/html" } });
    const whole = await readPaper("2605.03042", undefined, { fetch });
    expect(whole).toMatch(/^SECTIONS\n# Title\n## 3 Method\n## 4 Results/);
    expect(await readPaper("2605.03042", "Method", { fetch })).toMatch(
      /^## 3 Method\s+The method is X/,
    );
  });
});

describe("research loop (ported from Helga's research_loop)", () => {
  it("stops when the checklist is covered, and says the exit was measured", async () => {
    const r = await runResearchLoop(["sqlite transactions", "vitest timers"], async (q) => ({
      query: q,
      text: `about ${q}`,
      sources: [{ kind: "documentation", ref: q }],
    }));
    expect(r.stoppedBecause).toBe("covered");
    expect(r.coveragePct).toBe(100);
    expect(r.rounds).toBe(1);
    expect(r.exitRule).toMatch(/no model judgement/);
  });

  it("stops after two dry rounds instead of burning the budget", async () => {
    let n = 0;
    const r = await runResearchLoop(
      ["quantum pickles"],
      async (q) => {
        n++;
        return { query: q, text: "nothing", sources: [{ kind: "web", ref: "same" }] };
      },
      { maxRounds: 10 },
    );
    expect(r.stoppedBecause).toBe("dry");
    expect(n).toBe(3); // one round that found "same", then two that added nothing
    expect(r.outstanding).toEqual(["quantum pickles"]);
  });

  it("asks the model for new queries only for what is uncovered, runs them concurrently", async () => {
    let inFlight = 0;
    let peak = 0;
    const asked: string[][] = [];
    const r = await runResearchLoop(
      ["alpha widgets", "beta gadgets", "gamma gizmos"],
      async (q) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((res) => setTimeout(res, 5));
        inFlight--;
        return q.startsWith("better")
          ? { query: q, text: "gamma gizmos explained", sources: [{ kind: "paper", ref: q }] }
          : { query: q, text: q.includes("gamma") ? "" : q, sources: [{ kind: "web", ref: q }] };
      },
      {
        concurrency: 3,
        proposeQueries: async (outstanding, findings) => {
          asked.push(outstanding);
          return findings.length === 0 ? outstanding : outstanding.map((o) => `better ${o}`);
        },
      },
    );
    expect(peak).toBe(3);
    expect(asked[1]).toEqual(["gamma gizmos"]);
    expect(r.stoppedBecause).toBe("covered");
  });
});

/** A scripted model: each generate() returns the next step. */
function scripted(
  steps: ((req: InferenceRequest) => Partial<InferenceResponse>)[],
  opts: { native?: boolean; id?: string } = {},
): LocalInferenceAdapter & { requests: InferenceRequest[] } {
  const requests: InferenceRequest[] = [];
  let i = 0;
  return {
    modelId: opts.id ?? "generic-researcher",
    supportedArms: ["arm_a_flat"],
    nativeTools: opts.native ?? true,
    contextWindow: { contextTokens: 16384, maxTokens: 1500 },
    requests,
    async generate(req) {
      requests.push(structuredClone(req));
      const step = steps[Math.min(i++, steps.length - 1)] as (
        r: InferenceRequest,
      ) => Partial<InferenceResponse>;
      return {
        text: "",
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
        ...step(req),
      };
    },
  };
}

describe("the Researcher, generic native-tool path", () => {
  const deps = {
    repoPath: process.cwd(),
    today: "2026-09-18",
    fetchJson: async () => ({
      readme: "zod parses and validates. z.object({...}).parse(x)",
      license: "MIT",
    }),
  };

  it("uses native turns and parallel tool calls, and cites what it read", async () => {
    const model = scripted([
      () => ({
        text: "<think>two things</think>",
        toolCalls: [
          { id: "c1", name: "package_readme", arguments: { name: "zod" } },
          { id: "c2", name: "module_api", arguments: { module: "node:nonexistent" } },
        ],
      }),
      () => ({ text: "<think>ok</think>Use z.object().parse [1]." }),
    ]);
    const r = await research(model, "How do I validate input with zod?", deps);
    expect(model.requests[0]?.systemPrompt).toMatch(/## Research workflow/);
    expect(model.requests[0]?.tools?.map((t) => t.name)).toContain("package_readme");
    // Turn 2 carries the assistant's calls and one tool turn per call, by id.
    const turns = model.requests[1]?.messages ?? [];
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant", "tool", "tool"]);
    expect(turns[2]?.toolCallId).toBe("c1");
    expect(turns[2]?.content).toMatch(/^Source \[1\]: npm README of zod/);
    expect(r.answer).toBe("Use z.object().parse [1].");
    expect(r.grounded).toBe(true);
    expect(r.evidence[0]?.kind).toBe("documentation");
    expect(r.confidence).toBe(0.35);
    expect(r.badCitations).toEqual([]);
  });

  it("asks once for citations when an answer cites nothing, and flags citations to nothing", async () => {
    const model = scripted([
      () => ({ toolCalls: [{ id: "c1", name: "package_readme", arguments: { name: "zod" } }] }),
      () => ({ text: "Use parse." }),
      () => ({ text: "Use parse [1], see also [4]." }),
    ]);
    const r = await research(model, "zod?", deps);
    expect(model.requests[2]?.messages?.some((m) => /Rewrite the answer citing/.test(m.content))).toBe(true);
    expect(r.badCitations).toEqual([4]);
  });

  it("reports 'not settled' as not grounded, with zero confidence", async () => {
    const model = scripted([
      () => ({ toolCalls: [{ id: "c1", name: "package_readme", arguments: { name: "zod" } }] }),
      () => ({ text: "Not settled: the README does not say [1]." }),
    ]);
    const r = await research(model, "Does zod support X?", deps);
    expect(r.grounded).toBe(false);
    expect(r.confidence).toBe(0);
  });

  it("keeps a flat transcript for models without native tools", async () => {
    const model = scripted(
      [
        () => ({ toolCalls: [{ id: "c1", name: "package_readme", arguments: { name: "zod" } }] }),
        () => ({ text: "Use parse [1]." }),
      ],
      { native: false, id: "mistral-small" },
    );
    const r = await research(model, "zod?", deps);
    expect(model.requests[1]?.messages).toBeUndefined();
    expect(model.requests[1]?.prompt).toMatch(/SOURCES\n\[1\] npm README of zod/);
    expect(model.requests[1]?.temperature).toBe(0.2);
    expect(r.grounded).toBe(true);
  });

  it("masks old evidence past the budget, keeping the latest round whole", () => {
    const rounds = ["a".repeat(5000), "b".repeat(5000), "c".repeat(5000)];
    const out = maskOldEvidence(rounds, 8000);
    expect(out[0]).toMatch(/masked/);
    expect(out[2]).toBe(rounds[2]);
  });

  it("checks citation numbers against the sources", () => {
    expect(checkCitations("x [1] y [2] z [3]", 2)).toEqual([3]);
  });

  it("investigates in the Agent Team shape: decompose, research parts, merge with renumbered citations", async () => {
    const model = scripted([
      // Plan.
      () => ({ text: '["zod object parsing", "zod licence terms"]' }),
      // Sub-run 1: one tool call, then an answer citing [1].
      () => ({ toolCalls: [{ id: "a", name: "package_readme", arguments: { name: "zod" } }] }),
      () => ({ text: "zod object parsing uses z.object().parse [1]." }),
      // Sub-run 2: a different source.
      () => ({ toolCalls: [{ id: "b", name: "find_library", arguments: { query: "zod" } }] }),
      () => ({ text: "zod licence terms: MIT [1]." }),
      // Merge.
      (req) => ({
        text: req.prompt.includes("[2] npm registry search")
          ? "Parse with z.object [1]; MIT [2]."
          : "wrong",
      }),
    ]);
    const r = await investigate(model, "Can we use zod for input validation?", {
      ...deps,
      libraries: async () => [],
    });
    expect(r.coverage?.stoppedBecause).toBe("covered");
    expect(r.coverage?.coveragePct).toBe(100);
    expect(r.answer).toBe("Parse with z.object [1]; MIT [2].");
    expect(r.sources).toEqual(["npm README of zod", 'npm registry search "zod"']);
    expect(r.badCitations).toEqual([]);
    expect(r.grounded).toBe(true);
  });
});

describe("research service wiring", () => {
  it("reads pages through the crawler behind the robots gate, caching the result", async () => {
    const { fetchPage } = await import("../src/research/web.js");
    const crawled: string[] = [];
    const crawler = {
      crawl: async (url: string) => {
        crawled.push(url);
        return {
          ok: true,
          title: "Docs",
          markdown: `rendered ${"text ".repeat(100)} transactions here`,
        };
      },
    };
    const polite = new PoliteFetcher({
      fetch: async (url) =>
        url.endsWith("/robots.txt")
          ? new Response("User-agent: *\nDisallow: /private")
          : new Response("<p>plain</p>", { headers: { "content-type": "text/html" } }),
      pacer: new HostPacer(fakeClock()),
      cache: new ResearchCache(mkdtempSync(join(tmpdir(), "rc-"))),
    });
    const cfg = { polite, crawler };
    expect(await fetchPage("https://docs.example.dev/a", cfg)).toMatch(/^# Docs\n\nrendered/);
    expect(await fetchPage("https://docs.example.dev/a", cfg)).toMatch(/^# Docs/);
    expect(crawled).toEqual(["https://docs.example.dev/a"]); // second read from cache
    expect(await fetchPage("https://docs.example.dev/private/x", cfg)).toMatch(/robots/);
    expect(crawled).toHaveLength(1);
    expect(await fetchPage("http://10.0.0.2/", cfg)).toMatch(/private/);
    // A crawler failure falls back to the plain reader.
    const broken = { ...cfg, crawler: { crawl: async () => ({ ok: false, error: "x" }) } };
    expect(await fetchPage("https://docs.example.dev/b", broken)).toBe("plain");
  });

  it("never pulls the SearXNG image implicitly, and runs it on loopback when present", async () => {
    const { ensureSearxng, searxngSettings } = await import("../src/research/searxng.js");
    const down = async () => {
      throw new Error("down");
    };
    const calls: string[][] = [];
    const exec = (images: string) => async (_cmd: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "images") return images;
      return "";
    };
    expect(
      await ensureSearxng({
        exec: exec(""),
        fetch: down,
        configDir: mkdtempSync(join(tmpdir(), "sx-")),
      }),
    ).toBeUndefined();
    expect(calls.some((a) => a[0] === "pull" || a[0] === "run")).toBe(false);
    calls.length = 0;
    let started = false;
    const up = async () => {
      if (!started) throw new Error("down");
      return new Response("{}");
    };
    const exec2 = async (_cmd: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "images") return "abc123\n";
      if (args[0] === "run") started = true;
      return "";
    };
    expect(
      await ensureSearxng({
        exec: exec2,
        fetch: up as typeof fetch,
        configDir: mkdtempSync(join(tmpdir(), "sx-")),
      }),
    ).toMatch(/^http:\/\/127\.0\.0\.1:/);
    const run = calls.find((a) => a[0] === "run") ?? [];
    expect(run.join(" ")).toMatch(/-p 127\.0\.0\.1:\d+:8080/);
    const yml = searxngSettings("s3cret");
    expect(yml).toMatch(/formats: \[html, json\]/);
    expect(yml).toMatch(/limiter: false/);
    expect(yml).toMatch(/name: google\n {4}engine: google\n {4}disabled: true/);
  });

  it("answers from memory when the same question was answered well, and files research on the card", async () => {
    const { ResearchMemory, ResearchService } = await import("../src/research/service.js");
    const memory = new ResearchMemory(join(mkdtempSync(join(tmpdir(), "mem-")), "m.jsonl"));
    const dossier: { cardId: string; kind: string; text: string }[] = [];
    const cardStore = {
      recordDossierEntry: async (e: { cardId: string; kind: string; text: string }) => {
        dossier.push(e);
        return e;
      },
    };
    let loads = 0;
    const model = scripted([
      () => ({ toolCalls: [{ id: "c1", name: "package_readme", arguments: { name: "zod" } }] }),
      () => ({ text: "Use z.object().parse [1]." }),
    ]);
    const service = new ResearchService({
      repoPath: process.cwd(),
      memory,
      cardStore: cardStore as never,
      tools: { fetchJson: async () => ({ readme: "zod docs", license: "MIT" }) },
      model: async () => {
        loads++;
        return model;
      },
    });
    const first = await service.ask("How do I validate input with zod?", { cardId: "card_1" });
    expect(first.fromMemory).toBe(false);
    expect(loads).toBe(1);
    const second = await service.ask("how do I validate input with zod", {});
    expect(second.fromMemory).toBe(true);
    expect(loads).toBe(1); // no model load for a remembered answer
    expect(dossier[0]).toMatchObject({ cardId: "card_1", kind: "research" });
    expect(dossier[0]?.text).toMatch(/Sources: npm README of zod/);
    expect(
      (await service.ask("How do I validate input with zod?", { fresh: true })).fromMemory,
    ).toBe(false);
  });

  it("carries Crawl4AI's required attribution in the CLI help", async () => {
    const { RESEARCH_USAGE } = await import("../src/research/cli.js");
    expect(RESEARCH_USAGE).toMatch(/developed by UncleCode .* Crawl4AI project/);
  });
});
