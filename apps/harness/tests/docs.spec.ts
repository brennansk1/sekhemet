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

/**
 * The design is SPINE.md plus one specification per subsystem, and a spec's
 * status is stated once, in its front matter. Phase A found four separate
 * records of "what is built" that disagreed; these checks keep one.
 */
const DESIGN = join(DOCS, "design");
const SPECS = join(DESIGN, "specs");
const STATUSES = new Set(["built", "partial", "not-built"]);

type FrontMatter = Record<string, string | string[]>;

function frontMatter(text: string): FrontMatter | undefined {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) return undefined;
  const out: FrontMatter = {};
  let listKey = "";
  for (const line of (m[1] ?? "").split("\n")) {
    // A block list: "code:" followed by "  - path" lines.
    const item = /^\s+-\s+(.+?)\s*$/.exec(line);
    if (item && listKey) {
      const list = out[listKey];
      if (Array.isArray(list)) list.push(item[1] ?? "");
      continue;
    }
    const kv = /^([a-z-]+):\s*(.*?)\s*(?:#.*)?$/.exec(line);
    if (!kv) continue;
    const [, key = "", raw = ""] = kv;
    listKey = raw === "" ? key : "";
    out[key] =
      raw === ""
        ? []
        : raw.startsWith("[")
          ? raw
              .slice(1, -1)
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : raw;
  }
  return out;
}

/** The specs the index names, in its order. */
function indexedSpecs(): string[] {
  const index = readFileSync(join(SPECS, "README.md"), "utf8");
  const table = index.slice(
    index.indexOf("## The specifications"),
    index.indexOf("## Where the old design went"),
  );
  return [...table.matchAll(/^\| \[([a-z-]+)\.md\]/gm)].map((m) => m[1] ?? "");
}

/** Every change ID the programme defines: S1, S3a, M12, P4, T10… */
function coverageIds(): Set<string> {
  const coverage = readFileSync(join(DOCS, "reference", "COVERAGE.md"), "utf8");
  return new Set([...coverage.matchAll(/^\| \*{0,2}([SMPT]\d+[a-c]?)\b/gm)].map((m) => m[1] ?? ""));
}

describe("the design: spine and specifications", () => {
  const specs = indexedSpecs();

  it("indexes fifteen specifications, each present with valid front matter", () => {
    expect(specs.length).toBe(15);
    const problems: string[] = [];
    for (const name of specs) {
      const path = join(SPECS, `${name}.md`);
      if (!existsSync(path)) {
        problems.push(`${name}: missing`);
        continue;
      }
      const fm = frontMatter(readFileSync(path, "utf8"));
      if (!fm) problems.push(`${name}: no front matter`);
      else {
        if (fm.spec !== name) problems.push(`${name}: spec is ${String(fm.spec)}`);
        if (!STATUSES.has(String(fm.status))) problems.push(`${name}: status ${String(fm.status)}`);
        for (const key of ["code", "tests"]) {
          const paths = fm[key];
          if (!Array.isArray(paths)) problems.push(`${name}: ${key} is not a list`);
          else
            for (const p of paths)
              if (!existsSync(join(ROOT, p))) problems.push(`${name}: ${key} ${p} does not exist`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("names only change IDs the programme defines, and every ID has a spec", () => {
    const ids = coverageIds();
    const carried = new Set<string>();
    const unknown: string[] = [];
    for (const name of specs) {
      const path = join(SPECS, `${name}.md`);
      if (!existsSync(path)) continue;
      const changes = frontMatter(readFileSync(path, "utf8"))?.changes;
      for (const id of Array.isArray(changes) ? changes : []) {
        if (ids.has(id)) carried.add(id);
        else unknown.push(`${name}: ${id}`);
      }
    }
    expect(unknown).toEqual([]);
    expect([...ids].filter((id) => !carried.has(id))).toEqual([]);
  });

  it("shows every spec's status in the SPINE status table, exactly as its front matter says", () => {
    const spine = readFileSync(join(DESIGN, "SPINE.md"), "utf8");
    const table = spine.slice(
      spine.indexOf("<!-- status-table:start -->"),
      spine.indexOf("<!-- status-table:end -->"),
    );
    const rows = new Map(
      [...table.matchAll(/^\| \[([a-z-]+)\]\(specs\/[a-z-]+\.md\) \| `([a-z-]+)` \|/gm)].map(
        (m) => [m[1] ?? "", m[2] ?? ""],
      ),
    );
    const expected = new Map(
      specs
        .filter((n) => existsSync(join(SPECS, `${n}.md`)))
        .map((n) => [n, String(frontMatter(readFileSync(join(SPECS, `${n}.md`), "utf8"))?.status)]),
    );
    expect(Object.fromEntries(rows)).toEqual(Object.fromEntries(expected));
    expect(rows.size).toBe(15);
  });

  it("links nothing by absolute file:// path, which breaks in every other checkout", () => {
    const files = [
      ...[...ROOT_ALLOWED].map((n) => join(ROOT, n)).filter(existsSync),
      ...markdownUnder(DOCS),
    ];
    const absolute = files.filter((f) => /\]\(file:\/\//.test(readFileSync(f, "utf8")));
    expect(absolute.map((f) => relative(ROOT, f))).toEqual([]);
  });
});
