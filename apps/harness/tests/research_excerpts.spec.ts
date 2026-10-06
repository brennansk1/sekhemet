import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { excerpts, focusChunks } from "../src/research/docs.js";
import { HostPacer, PoliteFetcher, ResearchCache } from "../src/research/polite.js";
import { fetchPage } from "../src/research/web.js";

/**
 * Design-stage DS-N9-10: the question reaches Crawl4AI's BM25 filter and the
 * plain reader's own ranking; the raw page is cached once under `crawl:<url>`
 * whatever the question; at most five excerpts of heading-sized chunks, each
 * with its anchor, heading, text and the SHA-256 of the chunk and of the raw
 * page, deterministically and with no model.
 */

const sha256 = (t: string) => createHash("sha256").update(t).digest("hex");
const noWait = () => new HostPacer({ now: () => 0, sleep: async () => undefined });

const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A documentation page as Crawl4AI or the plain reader returns it: headings and paragraphs. */
const PAGE = [
  "# Client",
  "The client talks to the server over HTTP.",
  "## Installation",
  `Install it with the package manager. ${"Setup words. ".repeat(40)}`,
  "## Timeouts",
  "Set `timeout` on the Client to bound each request. A request past its timeout raises Timeout.",
  "## Sessions",
  "A Session keeps cookies and a connection pool across requests.",
  "## Retries",
  "Mount a retry adapter on the Session to retry a failed request with backoff.",
  "## Streaming",
  "Pass stream=True to read a large body in chunks.",
  "## Proxies",
  "Proxies are set per Session or per request.",
  "## Authentication",
  "Pass auth to the request; a Session keeps it across requests.",
].join("\n\n");

describe("question-focused excerpts (DS-N9-10)", () => {
  it("returns at most five heading-sized chunks with anchor, heading and hashes", () => {
    const out = excerpts(PAGE, "Session timeout request retry", {
      url: "https://docs.example.dev/client",
    });
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(5);
    for (const e of out) {
      expect(PAGE).toContain(e.text);
      expect(e.sha256).toBe(sha256(e.text));
      expect(e.pageSha256).toBe(sha256(PAGE));
      expect(e.url).toBe("https://docs.example.dev/client");
      expect(e.text.startsWith(`## ${e.heading}`) || e.heading === "Client").toBe(true);
    }
    const timeouts = out.find((e) => e.heading === "Timeouts");
    expect(timeouts?.anchor).toBe("timeouts");
    // The installation section names none of the question's words.
    expect(out.some((e) => e.heading === "Installation")).toBe(false);
  });

  it("gives the same excerpts and hashes for the same page and question", () => {
    const a = excerpts(PAGE, "How do I retry a request on a Session?", { url: "u" });
    const b = excerpts(PAGE, "How do I retry a request on a Session?", { url: "u" });
    expect(a).toEqual(b);
    expect(a.map((e) => e.sha256)).toEqual(b.map((e) => e.sha256));
    expect(a[0]?.heading).toBe("Retries");
  });

  it("caps at the asked maximum, and says nothing for a question the page does not answer", () => {
    expect(excerpts(PAGE, "request Session", { max: 2 })).toHaveLength(2);
    expect(excerpts(PAGE, "kubernetes helm chart")).toEqual([]);
  });

  it("excerpts a truncated page from what was read, each chunk verbatim", () => {
    // A page cut mid-section (a size cap, a dropped connection): the last
    // chunk is whatever arrived, and its hash is of exactly that text.
    const cut = `${PAGE.slice(0, PAGE.indexOf("connection pool") + 10)}`;
    const out = excerpts(cut, "Session connection pool", { url: "u" });
    const last = out.find((e) => e.heading === "Sessions");
    expect(last?.text.endsWith("connection")).toBe(true);
    expect(last?.sha256).toBe(sha256(last?.text ?? ""));
    expect(last?.pageSha256).toBe(sha256(cut));
  });

  it("numbers repeated headings' anchors as a docs site does", () => {
    const page = "# A\n\nintro\n\n## Usage\n\nfoo usage\n\n# B\n\nmore\n\n## Usage\n\nfoo again";
    const anchors = excerpts(page, "foo usage").map((e) => e.anchor);
    expect(anchors.sort()).toEqual(["usage", "usage-1"]);
  });

  it("keeps the reader's focused rendering of a long page, the opening first", () => {
    const text = focusChunks(PAGE, "retry adapter backoff", 400);
    expect(text.startsWith("# Client")).toBe(true);
    expect(text).toMatch(/retry adapter/);
    expect(text).not.toMatch(/Setup words/);
  });
});

describe("the question reaches the page reader (DS-N9-10)", () => {
  const politeWith = (cache: ResearchCache) =>
    new PoliteFetcher({
      fetch: async (url) =>
        url.endsWith("/robots.txt")
          ? new Response("User-agent: *\nAllow: /")
          : new Response("<p>plain</p>", { headers: { "content-type": "text/html" } }),
      pacer: noWait(),
      cache,
    });

  it("passes the question to Crawl4AI and caches the raw page once, whatever the question", async () => {
    const cacheDir = tmp("rc-");
    const cache = new ResearchCache(cacheDir);
    const asked: (string | undefined)[] = [];
    const crawler = {
      crawl: async (_url: string, query?: string) => {
        asked.push(query);
        return {
          ok: true,
          title: "Client",
          markdown: PAGE,
          fitMarkdown: "## Retries\n\nMount a retry adapter on the Session.",
        };
      },
    };
    const cfg = { polite: politeWith(cache), crawler };
    const first = await fetchPage("https://docs.example.dev/client", cfg, 600, "retry adapter");
    expect(asked).toEqual(["retry adapter"]);
    // The read that fetched the page is answered by Crawl4AI's BM25 filter.
    expect(first).toMatch(/Mount a retry adapter/);
    expect(first).not.toMatch(/talks to the server/);
    // A second question reads the same cached raw page: no second crawl, one entry.
    const second = await fetchPage("https://docs.example.dev/client", cfg, 600, "streaming body");
    expect(asked).toHaveLength(1);
    expect(second).toMatch(/stream=True/);
    expect(cache.get("crawl:https://docs.example.dev/client")?.body).toBe(`# Client\n\n${PAGE}`);
    expect(readdirSync(cacheDir).filter((f) => f.endsWith(".json"))).toHaveLength(1);
  });

  it("ranks the cached raw page for a question when Crawl4AI's filter kept nothing", async () => {
    const cache = new ResearchCache(tmp("rc-"));
    const crawler = {
      crawl: async () => ({ ok: true, title: "Client", markdown: PAGE, fitMarkdown: "" }),
    };
    const text = await fetchPage(
      "https://docs.example.dev/client",
      { polite: politeWith(cache), crawler },
      600,
      "proxies per request",
    );
    expect(text).toMatch(/Proxies are set per Session/);
    expect(text).not.toMatch(/Setup words/);
  });
});

describe("excerpts are sized, not only counted (DS-N9-10)", () => {
  it("cuts a 2,000-line code block into verbatim chunks of at most 1,200 characters", () => {
    const block = Array.from({ length: 2000 }, (_, i) => `const value${i} = parseTimeout(${i});`);
    const page = `# Timeouts\n\n\`\`\`js\n${block.join("\n")}\n\`\`\`\n\nOne long line: ${"timeout ".repeat(400)}\n`;
    const found = excerpts(page, "parseTimeout timeout");
    expect(found.length).toBeGreaterThan(0);
    expect(found.length).toBeLessThanOrEqual(5);
    for (const e of found) {
      expect(e.text.length).toBeLessThanOrEqual(1200);
      expect(page.includes(e.text)).toBe(true);
      expect(e.sha256).toBe(sha256(e.text));
    }
  });
});
