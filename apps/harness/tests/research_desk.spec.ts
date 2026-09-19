import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  depsFile,
  depsOutline,
  installed,
  manifestVersions,
  packageDir,
} from "../src/research/deps.js";
import { ResearchCache } from "../src/research/polite.js";
import { blame, parseSlug } from "../src/research/repo.js";

/** A throwaway project with one installed dependency, so no network is needed. */
function project(): string {
  const root = mkdtempSync(join(tmpdir(), "desk-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ dependencies: { widget: "^2.0.0" }, devDependencies: { absent: "^1.0.0" } }),
  );
  const pkg = join(root, "node_modules", "widget");
  mkdirSync(join(pkg, "dist"), { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({
      name: "widget",
      version: "2.3.1",
      main: "dist/index.js",
      types: "dist/index.d.ts",
      exports: { ".": { import: "./dist/index.mjs" } },
    }),
  );
  writeFileSync(
    join(pkg, "dist", "index.d.ts"),
    "export declare function spin(n: number): void;\n",
  );
  writeFileSync(join(pkg, "dist", "index.js"), "export function spin(n) { return n; }\n");
  writeFileSync(join(pkg, "README.md"), "# widget\n");
  return root;
}

describe("installed dependency source (tier 1)", () => {
  const root = project();

  it("resolves the package, its version and its declared entry points", () => {
    expect(packageDir(root, "widget")).toContain(join("node_modules", "widget"));
    const pkg = installed(root, "widget");
    expect(pkg?.version).toBe("2.3.1");
    expect(pkg?.entries).toEqual(
      expect.arrayContaining(["dist/index.js", "dist/index.d.ts", "./dist/index.mjs"]),
    );
  });

  it("reads a file from inside the package and refuses to walk out of it", () => {
    expect(depsFile(root, "widget", "dist/index.d.ts")).toContain("function spin");
    expect(depsFile(root, "widget", "../../package.json")).toBe("Invalid path.");
    expect(depsFile(root, "widget", "dist/../../../etc/passwd")).toBe("Invalid path.");
  });

  it("names the package rather than pretending, when it is not installed", () => {
    expect(depsFile(root, "absent", "index.js")).toBe("absent is not installed in this project.");
    expect(installed(root, "absent")).toBeUndefined();
  });

  it("outlines the interface: version, entry points, declarations", () => {
    const outline = depsOutline(root, "widget");
    expect(outline).toContain("widget@2.3.1");
    expect(outline).toContain("dist/index.d.ts");
  });

  it("reports only dependencies that are actually installed", () => {
    expect(manifestVersions(root)).toEqual([{ name: "widget", version: "2.3.1" }]);
  });

  it("rejects a name that is not a package name", () => {
    expect(packageDir(root, "../etc")).toBeUndefined();
    expect(packageDir(root, "a b")).toBeUndefined();
  });
});

describe("repository intelligence", () => {
  it("accepts owner/repo and GitHub URLs, and rejects the rest", () => {
    expect(parseSlug("unclecode/crawl4ai")).toEqual({ owner: "unclecode", repo: "crawl4ai" });
    expect(parseSlug("https://github.com/asg017/sqlite-vec")).toEqual({
      owner: "asg017",
      repo: "sqlite-vec",
    });
    expect(parseSlug("https://github.com/qwen/qwen3/tree/main/docs")).toEqual({
      owner: "qwen",
      repo: "qwen3",
    });
    expect(parseSlug("owner/repo.git")).toEqual({ owner: "owner", repo: "repo" });
    expect(parseSlug("not-a-slug")).toBeUndefined();
    expect(parseSlug("../../etc/passwd")).toBeUndefined();
    expect(parseSlug("owner/repo; rm -rf /")).toBeUndefined();
  });

  it("blames a line range in the local repository", () => {
    const out = blame(process.cwd(), "package.json", 1, 2);
    expect(out).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("refuses a traversal in a blame path", () => {
    expect(blame(process.cwd(), "../../../etc/passwd", 1, 2)).toBe("Invalid path.");
  });
});

describe("cache expiry by mutability", () => {
  const day = 24 * 3600 * 1000;

  it("never expires a read pinned to a commit SHA", () => {
    expect(ResearchCache.ttlFor("pinned:gh:file:abc:src/index.ts")).toBe(Number.POSITIVE_INFINITY);
    expect(ResearchCache.ttlFor("gh:tree:da39a3ee5e6b4b0d3255bfef95601890afd80709")).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it("expires by what the thing is, not by its file type", () => {
    expect(ResearchCache.ttlFor("https://api.openalex.org/works?search=x")).toBe(day);
    expect(ResearchCache.ttlFor("https://registry.npmjs.org/zod")).toBe(day);
    expect(ResearchCache.ttlFor("https://arxiv.org/abs/2609.02749")).toBe(30 * day);
    expect(ResearchCache.ttlFor("https://vitest.dev/llms.txt")).toBe(30 * day);
    expect(ResearchCache.ttlFor("https://docs.crawl4ai.com/core/quickstart/")).toBe(90 * day);
    expect(ResearchCache.ttlFor("https://github.com/a/b/issues/12")).toBe(14 * day);
    expect(ResearchCache.ttlFor("https://someone.medium.com/a-post")).toBe(14 * day);
  });

  it("serves a stale entry to the Desk while marking it stale", () => {
    const dir = mkdtempSync(join(tmpdir(), "cache-"));
    const cache = new ResearchCache(dir, 0);
    cache.set("https://example.com/x", 200, "text/html", "body text");
    expect(cache.get("https://example.com/x")).toBeUndefined();
    const stale = cache.entry("https://example.com/x");
    expect(stale?.body).toBe("body text");
    expect(stale?.fresh).toBe(false);
  });

  it("resolves the same bytes under a second URL to the first one seen", () => {
    const dir = mkdtempSync(join(tmpdir(), "cache-"));
    const cache = new ResearchCache(dir);
    cache.set("https://a.example/page", 200, "text/html", "identical body");
    cache.set("https://mirror.example/page", 200, "text/html", "identical body");
    expect(cache.canonicalOf("identical body")).toBe("https://a.example/page");
    expect(cache.canonicalOf("different body")).toBeUndefined();
  });
});
