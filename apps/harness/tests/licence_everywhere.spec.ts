import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ts } from "@sekhemet/gates";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { MockInferenceAdapter } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import { modelLicenceWarning } from "../src/config_api.js";
import { licenseGate } from "../src/license_gate.js";
import { answer } from "../src/pm/agent.js";
import { type LibraryCandidate, formatHits } from "../src/pm/libraries.js";
import { runResearchTool } from "../src/research/researcher.js";
import {
  type RepoCandidate,
  priorArtLines,
  reuseSurvey,
  searchRepos,
} from "../src/research/reuse.js";
import { githubSearch } from "../src/research/web.js";

/**
 * Design-stage P7: one licence classifier everywhere. The survey, both
 * `find_library` tools, both GitHub search paths, the licence gate and the
 * model page all judge a licence with `classifyLicence`, so the same string
 * never gets two verdicts (DS-P7-1, -2, -3, and -9's licence part). No test
 * here hands a `usable` value in: every one is computed.
 */

const ROOT = join(import.meta.dirname, "..", "..", "..");

/** DS-P7-1: every one of these is permissive. */
const PERMISSIVE = [
  "MIT-0",
  "Zlib",
  "BlueOak-1.0.0",
  "BSL-1.0",
  "MIT AND Apache-2.0",
  "Apache 2.0",
  "BSD-3-Clause",
];

const lib = (name: string, license: string): LibraryCandidate => ({
  name,
  ecosystem: "npm",
  version: "1.0.0",
  license,
  description: "Send emails with invoices attached",
  weeklyDownloads: 50000,
  url: `https://www.npmjs.com/package/${name}`,
});

const repo = (name: string, license: string): RepoCandidate => ({
  fullName: `org/${name}`,
  license,
  stars: 1200,
  archived: false,
  pushedAt: "2026-09-01T00:00:00Z",
  description: "Email invoices to customers",
  url: `https://github.com/org/${name}`,
});

const survey = (libs: LibraryCandidate[], repos: RepoCandidate[] = []) =>
  reuseSurvey(
    ["emails invoices"],
    { libraries: async () => libs, repos: async () => repos },
    { now: new Date("2026-09-27T00:00:00Z"), perNeed: 20 },
  ).then((f) => f[0]);

describe("the survey judges every licence with the classifier (DS-P7-1, -2, -3)", () => {
  it("DS-P7-1: recommends a package or repository under each permissive string", async () => {
    const f = await survey(
      PERMISSIVE.map((l, i) => lib(`mailer-${i}`, l)),
      PERMISSIVE.map((l, i) => repo(`invoices-${i}`, l)),
    );
    expect(f?.libraries.map((l) => l.license)).toEqual(PERMISSIVE);
    expect(f?.repos.map((r) => r.license)).toEqual(PERMISSIVE);
    expect(f?.libraries.every((l) => l.verdict === "permissive" && l.usable)).toBe(true);
    expect(f?.excluded).toEqual([]);
    expect(f?.flagged).toEqual([]);
  });

  it("DS-P7-2: flags weak copyleft, excludes and names strong, drops absent silently", async () => {
    const f = await survey(
      [
        lib("lgpl-mailer", "LGPL-3.0-or-later"),
        lib("mpl-mailer", "MPL-2.0"),
        lib("gpl-mailer", "GPL-3.0-only"),
        lib("nolicence-mailer", ""),
        lib("none-mailer", "NONE"),
      ],
      [repo("agpl-invoices", "AGPL-3.0"), repo("bare-invoices", "unknown")],
    );
    expect(f?.libraries).toEqual([]);
    expect(f?.repos).toEqual([]);
    expect(f?.flagged).toEqual(["lgpl-mailer (LGPL-3.0-or-later)", "mpl-mailer (MPL-2.0)"]);
    expect(f?.excluded).toEqual(["gpl-mailer (GPL-3.0-only)", "org/agpl-invoices (AGPL-3.0)"]);
    const text = priorArtLines(f ? [f] : []).join("\n");
    expect(text).toMatch(/weak copyleft.*lgpl-mailer \(LGPL-3\.0-or-later\)/);
    expect(text).toMatch(/excluded for their licence: gpl-mailer/);
    expect(text).not.toMatch(/nolicence-mailer|none-mailer|bare-invoices/);
  });

  it("DS-P7-3: a usable value handed in is ignored; the classifier's is used", async () => {
    // A search that claims a verdict (a stale cache, a buggy adapter) does not decide.
    const liar = { ...lib("gpl-mailer", "GPL-3.0-only"), usable: true } as LibraryCandidate;
    const modest = { ...lib("mit-mailer", "MIT-0"), usable: false } as LibraryCandidate;
    const f = await survey([liar, modest]);
    expect(f?.libraries.map((l) => [l.name, l.usable])).toEqual([["mit-mailer", true]]);
    expect(f?.excluded).toEqual(["gpl-mailer (GPL-3.0-only)"]);
  });

  it("DS-P7-9: GitHub's REST and gh paths give a licence the same verdict", async () => {
    const cases: [spdxId: string | null, ghKey: string | undefined][] = [
      ["MIT-0", "mit-0"],
      ["BSL-1.0", "bsl-1.0"],
      ["GPL-3.0", "gpl-3.0"],
      ["LGPL-2.1", "lgpl-2.1"],
      ["NOASSERTION", "other"],
      [null, undefined],
    ];
    const rest = await searchRepos("invoices", async () => ({
      items: cases.map(([spdx], i) => ({
        full_name: `org/r${i}`,
        license: spdx === null ? null : { spdx_id: spdx },
        stargazers_count: 100,
        archived: false,
        pushed_at: "2026-09-01T00:00:00Z",
        description: "invoices",
        html_url: `https://github.com/org/r${i}`,
      })),
    }));
    const gh = await githubSearch("invoices", "repos", {
      gh: async () =>
        JSON.stringify(
          cases.map(([, key], i) => ({
            fullName: `org/r${i}`,
            description: "invoices",
            stargazersCount: 100,
            ...(key ? { license: { key } } : {}),
            url: `https://github.com/org/r${i}`,
          })),
        ),
    });
    expect(Array.isArray(gh)).toBe(true);
    const expected = [
      "permissive",
      "permissive",
      "strong_copyleft",
      "weak_copyleft",
      "unknown",
      "absent",
    ];
    expect(rest.map((r) => r.verdict)).toEqual(expected);
    // DS-P7-2: both paths drop a repository with no licence silently.
    expect((gh as { title: string }[]).map((h) => h.title)).toEqual([
      "org/r0",
      "org/r1",
      "org/r2",
      "org/r3",
      "org/r4",
    ]);
    const words: Record<string, string> = {
      permissive: "permissive, usable",
      strong_copyleft: "strong copyleft",
      weak_copyleft: "weak copyleft",
      unknown: "no clear licence",
      absent: "no licence",
    };
    (gh as { meta?: string }[]).forEach((h, i) => {
      expect(h.meta).toContain(words[expected[i] as string]);
    });
  });
});

describe("find_library judges with the classifier, for Seshat and the Researcher (DS-P7-9)", () => {
  const candidates: LibraryCandidate[] = [
    lib("mit0-mailer", "MIT-0"),
    lib("mpl-mailer", "MPL-2.0"),
    lib("gpl-mailer", "GPL-3.0-only"),
    lib("bare-mailer", ""),
  ];

  it("formats each candidate with its computed verdict, and drops the unlicensed", () => {
    const text = formatHits("mailer", candidates);
    expect(text).toMatch(/mit0-mailer@1\.0\.0 \(npm, MIT-0, usable\)/);
    expect(text).toMatch(/mpl-mailer.*NOT usable: MPL-2\.0: weak copyleft/);
    expect(text).toMatch(/gpl-mailer.*NOT usable: GPL-3\.0-only: strong copyleft/);
    expect(text).not.toContain("bare-mailer");
  });

  it("the Researcher's find_library shows the same verdicts", async () => {
    const r = await runResearchTool(
      { id: "1", name: "find_library", arguments: { query: "mailer" } },
      { repoPath: ROOT, libraries: async () => candidates },
    );
    expect(r.text).toBe(formatHits("mailer", candidates));
    expect(r.text).toMatch(/mit0-mailer@1\.0\.0 \(npm, MIT-0, usable\)/);
    expect(r.text).not.toContain("bare-mailer");
  });

  it("Seshat's find_library shows the same verdicts", async () => {
    const db = new DatabaseSync(":memory:");
    initSchema(db);
    const cards = new CardStore(db, new EventLog(db));
    const usage = { promptTokens: 1, completionTokens: 1, durationMs: 1 };
    const model = new MockInferenceAdapter("dirk-27b", [
      {
        text: "",
        toolCalls: [{ id: "1", name: "find_library", arguments: { query: "mailer" } }],
        usage,
      },
      { text: "Use mit0-mailer.", toolCalls: [], usage },
    ]);
    await answer(
      model,
      {
        project: "p",
        cards: await cards.listCards(),
        cycles: [],
        recentRuns: [],
        pmModel: "dirk-27b",
        today: "2026-09-27",
      },
      [],
      [{ id: "m", seq: 1, role: "user", text: "Send invoices", createdAt: "", state: "queued" }],
      undefined,
      async () => candidates,
    );
    const second = model.callHistory[1]?.prompt ?? "";
    expect(second).toContain(formatHits("mailer", candidates));
    expect(second).toMatch(/mit0-mailer@1\.0\.0 \(npm, MIT-0, usable\)/);
    expect(second).not.toContain("bare-mailer");
    db.close();
  });
});

describe("the licence gate uses the same classifier (DS-P7-1, DS-P7-2)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** A repository whose main has no dependencies; the working tree adds `deps`. */
  function repoAdding(deps: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "licence-gate-"));
    dirs.push(root);
    const git = (...a: string[]) =>
      execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=T", ...a], {
        cwd: root,
        stdio: "ignore",
      });
    git("init", "-q", "-b", "main");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "app", dependencies: {} }));
    git("add", "-A");
    git("commit", "-q", "-m", "seed");
    const names = Object.keys(deps);
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "app",
        dependencies: Object.fromEntries(names.map((n) => [n, "1.0.0"])),
      }),
    );
    for (const [name, license] of Object.entries(deps)) {
      mkdirSync(join(root, "node_modules", name), { recursive: true });
      writeFileSync(
        join(root, "node_modules", name, "package.json"),
        JSON.stringify({ name, version: "1.0.0", license }),
      );
    }
    return root;
  }

  it("DS-P7-1: passes a dependency under each permissive string", () => {
    const root = repoAdding(Object.fromEntries(PERMISSIVE.map((l, i) => [`dep-${i}`, l])));
    const r = licenseGate(root);
    expect(r.failures).toEqual([]);
  });

  it("passes an expression written with lower-case operators (review of B4.5)", () => {
    const root = repoAdding({ "or-dep": "MIT or Apache-2.0", "and-dep": "MIT and Apache-2.0" });
    expect(licenseGate(root).failures).toEqual([]);
  });

  it("DS-P7-2: fails weak and strong copyleft, naming the licence and its verdict", () => {
    const root = repoAdding({ "lgpl-dep": "LGPL-3.0-or-later", "agpl-dep": "AGPL-3.0" });
    const r = licenseGate(root);
    const byDep = Object.fromEntries(r.failures.map((f) => [f.actual, f.errorExcerpt]));
    expect(byDep["lgpl-dep"]).toMatch(/LGPL-3\.0-or-later.*weak copyleft/);
    expect(byDep["agpl-dep"]).toMatch(/AGPL-3\.0.*strong copyleft/);
  });
});

describe("a model's licence is judged by the classifier too", () => {
  it("warns only when the licence is not permissive", () => {
    expect(modelLicenceWarning("apache-2.0")).toBeUndefined();
    expect(modelLicenceWarning("MIT-0")).toBeUndefined();
    expect(modelLicenceWarning(undefined)).toBeUndefined();
    // The old /apache|mit|bsd/ test passed any string that mentioned Apache.
    expect(modelLicenceWarning("apache-2.0 AND cc-by-nc-4.0")).toMatch(/check it allows your use/);
    expect(modelLicenceWarning("cc-by-nc-4.0")).toMatch(/cc-by-nc-4\.0/);
    expect(modelLicenceWarning("llama3")).toMatch(/check it allows your use/);
  });
});

describe("no other licence table or pattern remains (DS-P7-3)", () => {
  /** A licence id, or a word that stands for one, inside a string or regex literal. */
  const LICENCE_LITERAL =
    /\b(?:MIT(?:-0)?|ISC|0BSD|BSD(?:-[234]-Clause)?|Apache(?:-2\.0)?|[AL]?GPL(?:-[23](?:\.0)?)?|MPL(?:-2\.0)?|Unlicen[cs]e|UNLICENSED|NOASSERTION|SEE LICEN[CS]E|CC0(?:-1\.0)?|Zlib|BlueOak)\b/i;
  /**
   * Allowed, with the reason: the classifier itself; and the research
   * rubric's `LICENCE_NAMES`, which finds a licence's names in an answer's
   * prose to grade it, and judges nothing about using one.
   */
  const ALLOWED = new Set(["packages/gates/src/licence.ts", "packages/eval/src/screening_sets.ts"]);

  function sources(): string[] {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name === "dist") continue;
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts")) files.push(p);
      }
    };
    for (const top of ["apps", "packages"])
      for (const pkg of readdirSync(join(ROOT, top), { withFileTypes: true })) {
        const src = join(ROOT, top, pkg.name, "src");
        if (pkg.isDirectory() && readdirSync(join(ROOT, top, pkg.name)).includes("src")) walk(src);
      }
    return files;
  }

  function licenceLiterals(file: string): string[] {
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const out: string[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) return;
      const text =
        ts.isStringLiteralLike(n) || ts.isTemplateLiteralToken(n)
          ? n.text
          : ts.isRegularExpressionLiteral(n)
            ? n.text
            : undefined;
      if (text && LICENCE_LITERAL.test(text))
        out.push(
          `${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}: ${text.slice(0, 80)}`,
        );
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return out;
  }

  it("finds licence literals only in the classifier (and the answer rubric)", () => {
    const found = new Map<string, string[]>();
    for (const file of sources()) {
      const hits = licenceLiterals(file);
      if (hits.length) found.set(relative(ROOT, file).replaceAll("\\", "/"), hits);
    }
    // The scan is not vacuous: it sees the classifier's own special strings.
    expect(found.get("packages/gates/src/licence.ts")?.length).toBeGreaterThan(0);
    const stray = [...found].filter(([f]) => !ALLOWED.has(f));
    expect(stray).toEqual([]);
  });
});
