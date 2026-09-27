import { describe, expect, it } from "vitest";
import {
  fetchPage,
  githubSearch,
  htmlToText,
  searchPapers,
  webSearch,
} from "../src/research/web.js";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const text = (body: string, type = "text/html") =>
  new Response(body, { status: 200, headers: { "content-type": type } });

describe("the Researcher's web tools", () => {
  it("merges Hugging Face Papers and arXiv without duplicates", async () => {
    const hits = await searchPapers("agent harness", {
      fetch: async (url) =>
        String(url).includes("huggingface")
          ? json([
              {
                paper: { id: "2605.03042", upvotes: 12 },
                title: "ARIS",
                summary: "adversarial review",
                publishedAt: "2026-05-04T00:00:00Z",
              },
            ])
          : text(
              "<feed><entry><id>http://arxiv.org/abs/2605.03042v1</id><title>ARIS</title><summary>dup</summary></entry><entry><id>http://arxiv.org/abs/2609.20519v2</id><title>SoL-Pi</title><summary>token efficiency</summary><published>2026-09-18T00:00:00Z</published></entry></feed>",
              "application/atom+xml",
            ),
    });
    expect(hits.map((h) => h.url)).toEqual([
      "https://arxiv.org/abs/2605.03042",
      "https://arxiv.org/abs/2609.20519",
    ]);
  });

  it("refuses to fetch private or loopback addresses a model might choose", async () => {
    for (const url of [
      "http://localhost:4040/api/board",
      "http://192.168.1.5/",
      "http://127.0.0.1:11434/api/ps",
      "file:///etc/passwd",
    ]) {
      expect(await fetchPage(url, { fetch: async () => text("secret") })).toMatch(
        /Refusing|Only http/,
      );
    }
  });

  it("reduces HTML to readable text", () => {
    expect(
      htmlToText("<html><script>x()</script><h2>Setup</h2><p>Run <b>npm i</b> &amp; go</p></html>"),
    ).toBe("## Setup\n Run npm i & go");
  });

  it("uses the configured search provider, and says plainly when there is none", async () => {
    expect(await webSearch("x", {})).toMatch(/No web search provider is configured/);
    const hits = await webSearch("sqlite wal", {
      searxngUrl: "http://searx.local:8888",
      fetch: async () =>
        json({
          results: [
            {
              title: "WAL mode",
              url: "https://sqlite.org/wal.html",
              content: "Write-ahead log",
              engine: "brave",
            },
          ],
        }),
    });
    expect(hits).toEqual([
      {
        title: "WAL mode",
        url: "https://sqlite.org/wal.html",
        snippet: "Write-ahead log",
        meta: "brave",
      },
    ]);
  });

  it("searches GitHub through gh and reports licences", async () => {
    const hits = await githubSearch("agent harness", "repos", {
      gh: async () =>
        JSON.stringify([
          {
            fullName: "a/b",
            description: "d",
            stargazersCount: 5,
            license: { key: "mit" },
            url: "https://github.com/a/b",
          },
        ]),
    });
    expect(hits).toEqual([
      {
        title: "a/b",
        url: "https://github.com/a/b",
        snippet: "d",
        meta: "5 stars, licence mit (permissive, usable)",
      },
    ]);
  });
});
