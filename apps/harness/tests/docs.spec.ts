import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PRIMARY_COMMANDS } from "../src/cli_commands.js";
import { COMMAND_REGISTRY, GLOBAL_OPTIONS } from "../src/commands/registry.js";
import { BIN, cliEnv, place } from "./support/cli_spawn.js";

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
  // Keep a Changelog, bundled in the npm package for What's new (surface SUR-68).
  "CHANGELOG.md",
  // This machine's operations, git-ignored and imported by CLAUDE.md (DEC-54 c2).
  "CLAUDE.local.md",
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

  it("has no broken relative links in the root docs, docs/ or the community files in .github/", () => {
    const files = [
      ...[...ROOT_ALLOWED].map((n) => join(ROOT, n)).filter(existsSync),
      ...markdownUnder(DOCS),
      ...(existsSync(join(ROOT, ".github")) ? markdownUnder(join(ROOT, ".github")) : []),
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
    const item = /^\s+-\s+(.+?)\s*(?:#.*)?$/.exec(line);
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

/** Every change ID the programme defines: S1, S3a, M12, P4, T10, NEW-kernel-2… */
function coverageIds(): Set<string> {
  const coverage = readFileSync(join(DOCS, "reference", "COVERAGE.md"), "utf8");
  // A row marked "*Process — no subsystem spec*" is work on the documents or
  // the process itself (the design rebuild, the DoD audit), owned by no spec.
  const rows = coverage
    .split("\n")
    .filter((line) => !line.includes("*Process — no subsystem spec"));
  return new Set(
    rows.flatMap((line) => {
      const m = /^\| \*{0,2}([SMPT]\d+[a-c]?|NEW-[a-z-]+-\d+)\b/.exec(line);
      return m?.[1] ? [m[1]] : [];
    }),
  );
}

describe("the design: spine and specifications", () => {
  const specs = indexedSpecs();

  it("indexes sixteen specifications, each present with valid front matter", () => {
    expect(specs.length).toBe(16);
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
    expect(rows.size).toBe(16);
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

/**
 * What the README and the guide tell a person to type is what the built
 * command takes (FINISH_LINE_PLAN W3; surface SUR-20, SUR-60, SUR-69). Each
 * check runs the built binary, as a person would, and compares.
 */
const runBuilt = (args: string[]) => {
  const p = place("sek-docs-cli-");
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: p.repo,
    env: cliEnv(p),
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout, out: `${r.stdout}${r.stderr}` };
};

/** The rows of the markdown table between a generated block's markers. */
function blockRows(text: string, name: string): string[][] {
  const start = text.indexOf(`<!-- generated:${name}:start -->`);
  const end = text.indexOf(`<!-- generated:${name}:end -->`);
  if (start === -1 || end === -1) return [];
  return text
    .slice(start, end)
    .split("\n")
    .filter((l) => l.startsWith("| `"))
    .map((l) =>
      l
        .slice(1, -1)
        .split(/(?<!\\)\|/)
        // A table cell as written: pipes escaped, `<` and `>` as entities outside code.
        .map((c) => c.trim().replace(/\\\|/g, "|").replace(/&lt;/g, "<").replace(/&gt;/g, ">")),
    );
}

describe("the README and the guide against the built command", () => {
  it("SUR-20: the README's command table is the front door `sekhemet --help` prints, row for row", () => {
    const rows = blockRows(readFileSync(join(ROOT, "README.md"), "utf8"), "readme-commands");
    const table = rows.map(([usage = "", what = ""]) => ({
      usage: usage.replace(/^`|`$/g, ""),
      what,
    }));
    expect(table).toEqual(PRIMARY_COMMANDS.map((c) => ({ usage: c.usage, what: c.what })));
    const help = runBuilt(["--help"]);
    expect(help.code).toBe(0);
    for (const row of table) expect(help.stdout).toContain(`${row.usage}`);
    for (const row of table) expect(help.stdout).toContain(row.what);
  });

  it("SUR-60: every command and flag on the Upgrade and uninstall page is the registry's, and the built help names each flag", () => {
    const text = readFileSync(join(DOCS, "guide", "upgrade-and-uninstall.md"), "utf8");
    const lines = [...text.matchAll(/^(?:\$ )?sekhemet ([a-z][^\n#]*)$/gm)].map((m) =>
      (m[1] ?? "").trim(),
    );
    // The page gives the upgrade, the rollback and the uninstall lines.
    for (const needed of ["uninstall --dry-run", "uninstall --yes", "restore", "backup --list"])
      expect(
        lines.some((l) => l.startsWith(needed)),
        needed,
      ).toBe(true);
    const wrong: string[] = [];
    const flagsOf = new Map<string, Set<string>>();
    for (const line of lines) {
      const [name = "", ...rest] = line.split(/\s+/);
      const spec = COMMAND_REGISTRY.find((c) => c.name === name);
      if (!spec) {
        wrong.push(`${name}: not in the command registry`);
        continue;
      }
      for (const w of rest.filter((x) => x.startsWith("--"))) {
        const flag = w.slice(2).split("=")[0] ?? "";
        if (!Object.hasOwn(spec.options, flag) && !Object.hasOwn(GLOBAL_OPTIONS, flag))
          wrong.push(`${name} --${flag}: not a flag it takes`);
        else flagsOf.set(name, (flagsOf.get(name) ?? new Set()).add(flag));
      }
      if (!flagsOf.has(name)) flagsOf.set(name, new Set());
    }
    expect(wrong).toEqual([]);
    for (const [name, flags] of flagsOf) {
      const help = runBuilt([name, "--help"]);
      expect(help.code, name).toBe(0);
      for (const f of flags) expect(help.stdout, `${name} --${f}`).toContain(`--${f}`);
    }
  });

  it("SUR-69: SECURITY.md names the versions that receive fixes, covers the version the built command reports, and gives a private route", () => {
    const security = readFileSync(join(ROOT, ".github", "SECURITY.md"), "utf8");
    const rows = [
      ...security.matchAll(/^\| *`?(\d+)\.(\d+|x)(?:\.(?:\d+|x))?`?[^|]*\| *(Yes|No)\b/gm),
    ];
    const supported = rows.filter((m) => m[3] === "Yes");
    expect(supported.length).toBeGreaterThan(0);
    const version = runBuilt(["--version"]).stdout.trim();
    const [major, minor] = version.split(".");
    expect(
      rows.some((m) => m[1] === major && (m[2] === minor || m[2] === "x")),
      `SECURITY.md has no row for ${version}`,
    ).toBe(true);
    expect(security).toMatch(/security\/advisories\/new/);
    // The front door's help names where support and a private report go.
    const help = runBuilt(["--help"]).stdout;
    expect(help).toMatch(/SUPPORT\.md/);
    expect(help).toMatch(/privately/);
  });
});
