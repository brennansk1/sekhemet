import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Documentation stays organised because the build says so (the user's third
 * complaint: docs that drift into a mess). docs/README.md is the index.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DOCS = join(ROOT, "docs");
const ROOT_ALLOWED = new Set([
  "README.md",
  "AGENTS.md",
  "CLAUDE.md",
  "DEFINITION_OF_DONE.md",
  "DEV_LOG.md",
]);

function markdownUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...markdownUnder(path));
    else if (name.endsWith(".md")) out.push(path);
  }
  return out;
}

describe("documentation hygiene", () => {
  it("keeps only the fixed set of markdown files at the repository root", () => {
    const stray = readdirSync(ROOT).filter((n) => n.endsWith(".md") && !ROOT_ALLOWED.has(n));
    expect(stray).toEqual([]);
  });

  it("lists every document under docs/ in docs/README.md", () => {
    const index = readFileSync(join(DOCS, "README.md"), "utf8");
    const missing = markdownUnder(DOCS)
      .map((p) => relative(DOCS, p))
      .filter((p) => p !== "README.md" && !index.includes(`](${p})`));
    expect(missing).toEqual([]);
  });

  it("has no broken relative links in the root docs or docs/", () => {
    const files = [
      ...[...ROOT_ALLOWED].map((n) => join(ROOT, n)).filter(existsSync),
      ...markdownUnder(DOCS),
    ];
    const broken: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)) {
        const target = m[1] ?? "";
        if (/^(https?:|mailto:|file:)/.test(target)) continue;
        const path = resolve(dirname(file), decodeURIComponent(target));
        if (!existsSync(path)) broken.push(`${relative(ROOT, file)} -> ${target}`);
      }
    }
    expect(broken).toEqual([]);
  });
});
