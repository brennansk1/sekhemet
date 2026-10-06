import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installZod } from "./research_notes_fixture.js";
import { cli, cliStart, g2Dirs, ledgerRows, pathWithoutGh, until } from "./support/g2_cli.js";
import {
  type Recorded,
  SCRIPTED_MODEL,
  type Turn,
  recorded,
  scriptEnv,
} from "./support/g2_model.js";
import { type G2Project, g2Project } from "./support/g2_project.js";
import { type WebStub, htmlPage, webStub } from "./support/g2_web.js";

/**
 * `sekhemet research` through its door (design-stage §2.7, DS-N4-1, DS-N4-3,
 * DS-N2-4, DS-N2-5; FINISH_LINE_PLAN C2d): the built binary spawned
 * in a real repository, its Research model a scripted model at the HTTP
 * boundary, the web a local stub every `.test` host is routed to, and the
 * person's and the project's `config.toml` real files. Nothing leaves the
 * machine and no model is loaded.
 *
 * The binary under test is `apps/harness/dist/index.js`, spawned by
 * `support/g2_cli.ts`.
 */

const PARA =
  "Zod validates an email address with z.string().email(), which checks the string against its email pattern and adds an invalid_string issue when it does not match. ";
const GUIDE = "docs.lib.example.test/guide";

interface Run {
  p: G2Project;
  stub: WebStub;
  userConfig: string;
}

async function setup(
  opts: { user?: string; project?: string; pages?: string[] } = {},
): Promise<Run> {
  const where = g2Dirs();
  const p = await g2Project(where, {
    cards: [{ id: "c1", tier: "story", title: "Validate emails", status: "backlog" }],
  });
  const pages: Record<string, ReturnType<typeof htmlPage>> = {};
  for (const key of opts.pages ?? [GUIDE]) pages[key] = htmlPage(`Page ${key}`, [PARA.repeat(4)]);
  const stub = await webStub(pages);
  const userConfig = join(where.home, "config.toml");
  writeFileSync(userConfig, opts.user ?? '[network]\nmode = "open"\n');
  if (opts.project) writeFileSync(join(p.repo, ".sekhemet", "config.toml"), opts.project);
  p.env.SEKHEMET_USER_CONFIG = userConfig;
  return { p, stub, userConfig };
}

function research(run: Run, args: string[], researcher: Turn[], other?: string | string[]) {
  return cli(["research", ...args, "--model", SCRIPTED_MODEL], {
    cwd: run.p.repo,
    preload: run.p.preload,
    env: {
      ...run.p.env,
      G2_STUB_PORT: String(run.stub.port),
      SEKHEMET_SEARXNG_URL: "http://search.example.test",
      ...scriptEnv(run.p.record, { researcher, ...(other !== undefined ? { other } : {}) }),
    },
    timeoutMs: 120_000,
  });
}

/** Every tool result the Researcher was shown, joined. */
const toolResults = (rs: Recorded[]) =>
  rs
    .flatMap((r) => r.body.messages.filter((m) => m.role === "tool").map((m) => m.content))
    .join("\n");
const fetched = (stub: WebStub) => stub.requests.filter((r) => !r.endsWith("robots.txt"));
const fetch = (url: string) => ({ name: "web_fetch", arguments: { url } });

describe("sekhemet research: fetch_deny and the citations it checks", () => {
  it("DS-N4-3, DS-N2-4: a denied host and its subdomains are refused, naming the file and rule, even in open mode; a citation to nothing read is flagged", async () => {
    const run = await setup({
      user: '[network]\nmode = "open"\nfetch_allow = ["bad.example.test"]\nfetch_deny = ["bad.example.test"]\n',
      project: '[network]\nfetch_deny = ["worse.example.test"]\n',
    });
    const r = await research(
      run,
      ["How does zod validate an email?", "--web", "--json"],
      [
        [
          fetch(`https://${GUIDE}`),
          fetch("https://docs.bad.example.test/x"),
          fetch("https://worse.example.test/y"),
        ],
        "Use z.string().email() [1]. It is the fastest validator [2].",
      ],
    );
    expect(r.status === 0 || r.status === 2, r.stderr).toBe(true);
    const shown = toolResults(recorded(run.p.record));
    expect(shown).toMatch(
      /Refusing docs\.bad\.example\.test: it is in \[network\] fetch_deny \(rule "bad\.example\.test" in [^)]*config\.toml\)/,
    );
    expect(shown).toMatch(
      /Refusing worse\.example\.test: [^\n]*rule "worse\.example\.test" in [^)]*\.sekhemet\/config\.toml/,
    );
    // Never asked: the stub saw only the allowed page.
    expect(fetched(run.stub)).toEqual([GUIDE]);
    const answer = JSON.parse(r.stdout.slice(r.stdout.indexOf("{"))) as {
      sources: string[];
      badCitations: number[];
      grounded: boolean;
    };
    expect(answer.sources).toEqual([`https://${GUIDE}`]);
    // [2] points at nothing read.
    expect(answer.badCitations).toContain(2);
    expect(answer.badCitations).not.toContain(1);
  }, 180_000);
});

describe("sekhemet research --effort (DS-N4-1)", () => {
  it("DS-N4-1: records the effort with the answer and holds quick to its page reads per sub-question", async () => {
    const pages = Array.from({ length: 6 }, (_, i) => `p${i}.example.test/doc`);
    const run = await setup({ pages });
    const r = await research(
      run,
      ["How does zod validate an email?", "--web", "--effort", "quick", "--json"],
      [pages.map((k) => fetch(`https://${k}`)), "Use z.string().email() [1]."],
    );
    const answer = JSON.parse(r.stdout.slice(r.stdout.indexOf("{"))) as { effort: string };
    expect(answer.effort).toBe("quick");
    // Quick reads at most four pages for its one sub-question.
    expect(fetched(run.stub)).toHaveLength(4);
    const standard = await research(
      run,
      ["How does zod validate an email?", "--web", "--effort", "standard", "--fresh", "--json"],
      [[fetch(`https://${pages[0]}`)], "Use z.string().email() [1]."],
      "Use z.string().email().",
    );
    const second = JSON.parse(standard.stdout.slice(standard.stdout.indexOf("{"))) as {
      effort: string;
    };
    expect(second.effort).toBe("standard");
  }, 240_000);

  it("DS-N4-1: exhaustive research is refused while a card is running, and offered for the overnight window", async () => {
    const where = g2Dirs();
    const p = await g2Project(where, {
      cards: [
        { id: "c1", tier: "story", title: "Write a", scopeFiles: ["src/a.ts"], stepBudget: 2 },
      ],
    });
    const running = cliStart(["queue", "--worker", SCRIPTED_MODEL], {
      cwd: p.repo,
      preload: p.preload,
      env: { ...p.env, ...scriptEnv(p.record, { hang: "worker" }) },
    });
    try {
      // The card is running once its Worker has been asked.
      await until(() => recorded(p.record).some((x) => x.role === "worker"));
      const r = await cli(
        [
          "research",
          "Which CSV parser streams?",
          "--effort",
          "exhaustive",
          "--model",
          SCRIPTED_MODEL,
        ],
        { cwd: p.repo, env: p.env },
      );
      expect(r.status).toBe(1);
      expect(r.stdout).toMatch(
        /Exhaustive research is refused while (issue c1 is running|a queue holds the machine) \(pid \d+\)/,
      );
      expect(r.stdout).toMatch(
        /Run it in the overnight window instead: add an issue labelled "research" and "effort:exhaustive"/,
      );
    } finally {
      await running.stop();
    }
  }, 120_000);
});

describe("research memory (DS-N2-5)", () => {
  it("DS-N2-5: an answer is reused in the same repository at the same installed version, and never for another repository or another version", async () => {
    const root = g2Dirs();
    const home = root.home;
    const stub = await webStub({ [GUIDE]: htmlPage("Zod strings guide", [PARA.repeat(4)]) });
    const repoAt = async (name: string) => {
      const cwd = join(root.root, name);
      mkdirSync(cwd);
      const p = await g2Project(
        { cwd, home },
        {
          files: { "src/a.ts": "" },
          cards: [{ id: "c1", tier: "story", title: "Validate emails", status: "backlog" }],
        },
      );
      installZod(cwd, "3.23.8");
      return p;
    };
    const q = "How do I validate an email with zod?";
    const ask = (p: G2Project) =>
      cli(["research", q, "--web", "--json", "--model", SCRIPTED_MODEL], {
        cwd: p.repo,
        preload: p.preload,
        env: {
          ...p.env,
          G2_STUB_PORT: String(stub.port),
          SEKHEMET_SEARXNG_URL: "http://search.example.test",
          ...scriptEnv(p.record, {
            researcher: [[fetch(`https://${GUIDE}`)], "Use z.string().email() [1]."],
          }),
        },
        timeoutMs: 120_000,
      });
    const fromMemory = (stdout: string) =>
      (JSON.parse(stdout.slice(stdout.indexOf("{"))) as { fromMemory: boolean }).fromMemory;
    const a = await repoAt("a");
    const first = await ask(a);
    expect(fromMemory(first.stdout), first.stdout + first.stderr).toBe(false);
    const again = await ask(a);
    expect(fromMemory(again.stdout)).toBe(true);
    // Another repository at the same version: researched afresh.
    const b = await repoAt("b");
    expect(fromMemory((await ask(b)).stdout)).toBe(false);
    // The first repository after an upgrade: researched afresh.
    writeFileSync(
      join(a.repo, "node_modules", "zod", "package.json"),
      JSON.stringify({ name: "zod", version: "4.0.0" }),
    );
    expect(fromMemory((await ask(a)).stdout)).toBe(false);
  }, 240_000);
});

describe("the Researcher's find_library (DS-P7-9)", () => {
  const pkg = (name: string, license: string | undefined, weekly: number) => ({
    package: {
      name,
      version: "1.0.0",
      description: `email address validation ${name}`,
      keywords: ["email", "validation"],
      ...(license ? { license } : {}),
      date: "2025-09-01",
      links: { npm: `https://www.npmjs.com/package/${name}` },
    },
    downloads: { weekly, monthly: weekly * 4 },
  });

  it("DS-P7-9, DS-P7-1, DS-P7-2, DS-P7-4: applies the survey's licence, popularity and relevance filters, judging every licence with the same classifier", async () => {
    const run = await setup();
    const objects = [
      pkg("mail-mit0", "MIT-0", 900_000),
      pkg("mail-zlib", "Zlib", 800_000),
      pkg("mail-blueoak", "BlueOak-1.0.0", 700_000),
      pkg("mail-bsl", "BSL-1.0", 600_000),
      pkg("mail-dual", "MIT AND Apache-2.0", 500_000),
      pkg("mail-apache", "Apache 2.0", 400_000),
      pkg("mail-bsd", "BSD-3-Clause", 300_000),
      pkg("mail-lgpl", "LGPL-3.0-or-later", 950_000),
      pkg("mail-mpl", "MPL-2.0", 940_000),
      pkg("mail-gpl", "GPL-3.0-only", 930_000),
      pkg("mail-agpl", "AGPL-3.0", 920_000),
      pkg("mail-nolicence", undefined, 910_000),
      pkg("mail-unused", "MIT", 0),
    ];
    const stub = await webStub({
      "registry.npmjs.org/-/v1/search": () => ({
        type: "application/json",
        body: JSON.stringify({ objects }),
      }),
    });
    const r = await research(
      { ...run, stub },
      ["Which package validates email addresses?", "--web", "--json"],
      [
        [{ name: "find_library", arguments: { query: "email validation", ecosystem: "npm" } }],
        "Use mail-mit0.",
      ],
    );
    expect(r.status === 0 || r.status === 2, r.stderr).toBe(true);
    const shown = toolResults(recorded(run.p.record));
    const line = (name: string) => shown.split("\n").find((l) => l.startsWith(`- ${name}@`)) ?? "";
    // DS-P7-1: each permissive licence string is usable.
    for (const name of ["mit0", "zlib", "blueoak", "bsl", "dual", "apache", "bsd"]) {
      expect(line(`mail-${name}`)).toMatch(/, usable\)/);
    }
    // DS-P7-2: weak copyleft flagged; strong copyleft named as not usable; no licence: dropped.
    for (const name of ["lgpl", "mpl"])
      expect(line(`mail-${name}`)).toMatch(/NOT usable: [^:]+: weak copyleft, check with the team/);
    for (const name of ["gpl", "agpl"])
      expect(line(`mail-${name}`)).toMatch(/NOT usable: [^:]+: strong copyleft/);
    expect(shown).not.toContain("mail-nolicence");
    // DS-P7-4: no downloads and no stars: not offered.
    expect(shown).not.toContain("mail-unused");
  }, 120_000);
});

describe("the Researcher's dependency tools, pinned docs and probes (DS-N9)", () => {
  const ZOD_JS =
    "exports.z = { string: () => ({ email: () => ({ parse: (s) => { if (!/@/.test(s)) throw new Error('Invalid email'); return s; } }) }) };\n";
  const LLMS = `# Zod 3.23.8\n\n## Strings\n\nz.string().email() validates an email address. ${"It reports invalid_string when the value is not an email address. ".repeat(5)}\n\n## Numbers\n\nz.number().int() checks integers.\n`;

  async function zodRepo(): Promise<G2Project> {
    const p = await g2Project(g2Dirs(), {
      files: {
        "src/schema.ts": 'import { z } from "zod";\n',
        ".gitignore": "node_modules\n.sekhemet/\n",
      },
      cards: [{ id: "c1", tier: "story", title: "Validate emails", status: "backlog" }],
    });
    installZod(p.repo);
    writeFileSync(join(p.repo, "node_modules/zod/lib/index.js"), ZOD_JS);
    return p;
  }
  const ask = (
    p: G2Project,
    stub: WebStub,
    args: string[],
    researcher: Turn[],
    env: Record<string, string> = {},
  ) =>
    cli(
      ["research", "How does zod validate an email?", "--model", SCRIPTED_MODEL, "--json", ...args],
      {
        cwd: p.repo,
        preload: p.preload,
        env: {
          ...p.env,
          G2_STUB_PORT: String(stub.port),
          SEKHEMET_SEARXNG_URL: "http://search.example.test",
          PATH: pathWithoutGh(p.home),
          ...scriptEnv(p.record, { researcher }),
          ...env,
        },
        timeoutMs: 120_000,
      },
    );
  const json = (stdout: string) =>
    JSON.parse(stdout.slice(stdout.indexOf("{"))) as Record<string, unknown>;

  it("DS-N9-1, DS-N9-6, DS-N9-8, DS-N9-9, DS-N9-10, DS-N9-11, DS-N9-12, DS-N9-14: reads the installed package at its version, confined to it, and its docs at the pinned version through the polite fetcher", async () => {
    const p = await zodRepo();
    const stub = await webStub({
      "unpkg.com/zod@3.23.8/llms.txt": { type: "text/plain", body: LLMS },
    });
    const r = await ask(
      p,
      stub,
      ["--web"],
      [
        [
          { name: "deps_source", arguments: { name: "zod" } },
          { name: "deps_source", arguments: { name: "zod", path: "lib/types.d.ts" } },
          { name: "deps_source", arguments: { name: "zod", path: "../../package.json" } },
          { name: "deps_grep", arguments: { name: "zod", pattern: "email" } },
          {
            name: "read_docs",
            arguments: { library: "zod", question: "how does email validation work" },
          },
        ],
        "z.string().email() validates an address [5].",
      ],
    );
    expect(r.stdout, r.stderr).toContain('"effort"');
    const shown = toolResults(recorded(p.record));
    // DS-N9-1: the npm adapter gives the version in use, the source root, the files to read.
    expect(shown).toMatch(
      /zod@3\.23\.8 at .*\/node_modules\/zod\nentry points: \.\/lib\/index\.js, \.\/index\.d\.ts\ndeclarations:\nindex\.d\.ts\nlib\/external\.d\.ts/,
    );
    // DS-N9-14, DS-N9-6: read at that version, and confined to the package: a `..` path is refused.
    expect(shown).toContain("    email(message?: errorUtil.ErrMessage): ZodString;");
    expect(shown).toMatch(/Source \[3\]: zod@3\.23\.8 \.\.\/\.\.\/package\.json\nInvalid path\./);
    expect(shown).toMatch(
      /\.\/lib\/types\.d\.ts:7: {4}email\(message\?: errorUtil\.ErrMessage\): ZodString;/,
    );
    // DS-N9-8, DS-N9-12: the docs at the pinned version, npm's llms.txt first;
    // DS-N9-9: robots.txt read first, through the polite fetcher.
    expect(stub.requests.slice(0, 2)).toEqual([
      "unpkg.com/robots.txt",
      "unpkg.com/zod@3.23.8/llms.txt",
    ]);
    // DS-N9-10: heading-sized excerpts for the question, each with its anchor, at most 1,200 characters.
    expect(shown).toMatch(
      /### Strings \(https:\/\/unpkg\.com\/zod@3\.23\.8\/llms\.txt#strings\)\n## Strings\n\nz\.string\(\)\.email\(\) validates/,
    );
    const docs = shown.slice(shown.indexOf("Source [5]"));
    expect(docs).toMatch(/the version this project pins/);
    expect((docs.match(/^### /gm) ?? []).length).toBeLessThanOrEqual(5);
    for (const chunk of docs.split(/^### /m).slice(1))
      expect(chunk.length).toBeLessThanOrEqual(1_400);
    // DS-N9-11: the question carried the pin, recorded on research/asked.
    const asked = ledgerRows(p.repo).find((x) => x.type === "research/asked");
    expect(asked?.payload.pins).toEqual(["npm:zod@3.23.8"]);
    expect(
      recorded(p.record)[0]
        ?.body.messages.map((m) => m.content)
        .join("\n"),
    ).toContain("zod@3.23.8");
  }, 120_000);

  it("DS-N9-9: with research off nothing is fetched for the docs; a denied docs host is refused", async () => {
    const p = await zodRepo();
    const stub = await webStub({
      "unpkg.com/zod@3.23.8/llms.txt": { type: "text/plain", body: LLMS },
    });
    const docs: Turn = [{ name: "read_docs", arguments: { library: "zod", question: "email" } }];
    await ask(p, stub, ["--offline"], [docs, "Not settled: offline."]);
    expect(stub.requests).toEqual([]);
    const user = join(p.home, "config.toml");
    writeFileSync(user, '[network]\nmode = "open"\nfetch_deny = ["unpkg.com"]\n');
    await ask(p, stub, ["--web", "--fresh"], [docs, "Not settled: denied."], {
      SEKHEMET_USER_CONFIG: user,
    });
    expect(stub.requests.filter((x) => x.startsWith("unpkg.com"))).toEqual([]);
  }, 120_000);

  it("DS-N9-13, DS-N9-17, DS-N9-18: probes run sandboxed against the installed package up to the effort's budget; a long or wrong-language program is refused before it runs; one that exits 0 is an executable claim reproducing its program", async () => {
    const p = await zodRepo();
    const stub = await webStub({});
    const good =
      "const { z } = require('zod');\nz.string().email().parse('a@b.co');\nlet threw = false;\ntry { z.string().email().parse('nope'); } catch { threw = true; }\nconsole.log('email() refuses nope: ' + threw);\nprocess.exit(threw ? 0 : 1);";
    const long = Array.from({ length: 31 }, (_, i) => `const x${i} = ${i};`).join("\n");
    const writes = `const fs = require('fs');\nfs.writeFileSync(${JSON.stringify(join(p.repo, "node_modules/zod/pwned.txt"))}, 'x');\nconsole.log('wrote');`;
    const probe = (
      code: string,
      language = "node",
      statement = "zod 3.23.8 z.string().email() refuses an address without @",
    ) => ({
      name: "probe",
      arguments: { package: "zod", language, code, statement },
    });
    // Quick allows two probes per question: one that holds and one that
    // does not run; a program in another language is refused before it runs,
    // and a third probe is past the budget.
    const r = await ask(
      p,
      stub,
      ["--effort", "quick"],
      [
        [probe(good), probe("import zod", "python")],
        [
          probe("process.exit(1)", "node", "a statement that does not hold"),
          probe("console.log('a third probe'); process.exit(0)", "node", "a third probe"),
        ],
        "z.string().email() refuses it [1].",
      ],
    );
    const shown = toolResults(recorded(p.record));
    // DS-N9-17: refused before running — not the package's language.
    expect(shown).toMatch(
      /Probe refused before running: language "python" is for another ecosystem/,
    );
    // The output the model sees is wrapped as untrusted.
    expect(shown).toMatch(/exit 0[^\n]*\n<untrusted source="probe">\nemail\(\) refuses nope: true/);
    // DS-N9-13: the third probe is past quick's budget of two, refused before it runs.
    expect(shown).not.toContain("a third probe");
    expect(shown).toContain("The probe budget for this question (2 probes) is spent.");
    // DS-N9-17: over 30 lines is refused before running; a program that runs
    // may read the dependency's root and never write it.
    writeFileSync(p.record, "");
    await ask(
      p,
      stub,
      ["--effort", "quick", "--fresh"],
      [[probe(long), probe(writes)], "Not settled."],
    );
    const second = toolResults(recorded(p.record));
    expect(second).toContain(
      "Probe refused before running: 31 lines, and the limit is 30. Shorten it.",
    );
    expect(second).toMatch(
      /ran: exit 1[\s\S]*EPERM: operation not permitted, open '[^']*node_modules\/zod\/pwned\.txt'/,
    );
    expect(existsSync(join(p.repo, "node_modules/zod/pwned.txt"))).toBe(false);
    // DS-N9-18: the probe that exited 0 is an executable claim whose reproduction is the program that ran.
    const claims = json(r.stdout).probeClaims as {
      kind: string;
      text: string;
      reproduce: { language: string; code: string };
    }[];
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ kind: "executable", reproduce: { language: "node" } });
    expect(claims[0]?.text).toMatch(/refuses an address without @ \(reproduced at zod@3\.23\.8\)/);
    expect(claims[0]?.reproduce.code).toContain(good);
  }, 120_000);

  it("DS-N9-3: a Go dependency is read at go.mod's version from the module cache, without go installed", async () => {
    const p = await g2Project(g2Dirs(), {
      files: {
        "go.mod":
          "module example.com/app\n\ngo 1.22\n\nrequire (\n\tgithub.com/BurntSushi/toml v1.3.2\n)\n",
        "go.sum":
          "github.com/BurntSushi/toml v1.3.2 h1:a=\ngithub.com/BurntSushi/toml v1.3.2/go.mod h1:b=\n",
        "main.go": "package main\n\nfunc main() {}\n",
      },
      cards: [{ id: "c1", tier: "story", title: "Read config", status: "backlog" }],
    });
    const cache = join(p.home, "gomod");
    const toml = join(cache, "github.com", "!burnt!sushi", "toml@v1.3.2");
    writeFileSync(join(p.home, ".keep"), "");
    mkdirSync(toml, { recursive: true });
    writeFileSync(join(toml, "go.mod"), "module github.com/BurntSushi/toml\n");
    writeFileSync(
      join(toml, "decode.go"),
      "// Package toml implements decoding of TOML.\npackage toml\n\n// Decode decodes the contents of data in TOML format into v.\nfunc Decode(data string, v any) (MetaData, error) {\n\treturn MetaData{}, nil\n}\n\ntype MetaData struct{}\n",
    );
    const stub = await webStub({});
    await ask(
      p,
      stub,
      ["--offline"],
      [
        [
          { name: "deps_source", arguments: { name: "go:github.com/BurntSushi/toml" } },
          { name: "deps_grep", arguments: { name: "go:toml", pattern: "func Decode" } },
        ],
        "Not settled.",
      ],
      { GOMODCACHE: cache },
    );
    const shown = toolResults(recorded(p.record));
    expect(shown).toMatch(
      /github\.com\/BurntSushi\/toml@v1\.3\.2 \(go\) at .*gomod\/github\.com\/!burnt!sushi\/toml@v1\.3\.2/,
    );
    expect(shown).toMatch(/decode\.go:5:func Decode\(data string, v any\) \(MetaData, error\) \{/);
  }, 120_000);
});

describe("sekhemet research --effort exhaustive: coverage, the gated critique and disagreements", () => {
  const A =
    "Zod validates an email address with z.string().email() in version 3, and reports invalid_string. ".repeat(
      6,
    );
  const B = "In zod 4 the email check moved to the top-level z.email() function. ".repeat(6);
  const Q = "How does zod validate an email?";

  async function deep(
    pages: Record<string, string>,
    researcher: Turn[],
    other: string[],
    json = true,
  ) {
    const run = await setup();
    const stub = await webStub(
      Object.fromEntries(Object.entries(pages).map(([k, v]) => [k, htmlPage(`Page ${k}`, [v])])),
    );
    const r = await research(
      { ...run, stub },
      [Q, "--web", "--effort", "exhaustive", ...(json ? ["--json"] : [])],
      researcher,
      other,
    );
    return { r, run, stub, sent: recorded(run.p.record) };
  }
  const answerOf = (stdout: string) =>
    JSON.parse(stdout.slice(stdout.indexOf("{"))) as Record<string, unknown>;
  const asked = (sent: Recorded[], pattern: RegExp) =>
    sent.filter((x) => x.body.messages.some((m) => pattern.test(m.content)));

  it("DS-N4-2: a sub-question with fewer than two independent primary or secondary hosts stays open, is re-dispatched once with new queries, then reported uncovered", async () => {
    const { r, sent } = await deep(
      { "zod.example.test/api": A, "blog.example.test/zod-email": B },
      [
        [fetch("https://zod.example.test/api"), fetch("https://blog.example.test/zod-email")],
        "Zod validates email with z.string().email() [1]. Another source says z.email() [2].",
      ],
      [
        Q,
        "How does the zod library check an email string?",
        "Not settled: the sources read do not settle it.",
      ],
    );
    const a = answerOf(r.stdout) as {
      coverage: { covered: string[]; outstanding: string[]; rounds: number };
    };
    // Re-dispatched once, with the part named and what was tried.
    const redispatch = asked(sent, /These parts are not yet covered by any source/);
    expect(redispatch).toHaveLength(1);
    expect(redispatch[0]?.body.messages.map((m) => m.content).join("\n")).toMatch(
      /Already tried:\n- How does zod validate an email\?/,
    );
    expect(a.coverage.rounds).toBe(2);
    expect(a.coverage.covered).toEqual([]);
    expect(a.coverage.outstanding).toEqual([Q]);

    // Control: two independent hosts of primary and secondary tier close it at once.
    const control = await deep(
      { "nodejs.org/api/zod.html": A, "github.com/colinhacks/zod": B },
      [
        [fetch("https://nodejs.org/api/zod.html"), fetch("https://github.com/colinhacks/zod")],
        "Zod validates email with z.string().email() [1]. Zod 4 moved it to z.email() [2].",
      ],
      [Q, "Zod validates email with z.string().email() [1]. Zod 4 moved it to z.email() [2].", ""],
    );
    const c = answerOf(control.r.stdout) as { coverage: { covered: string[]; rounds: number } };
    expect(c.coverage.covered).toEqual([Q]);
    expect(asked(control.sent, /These parts are not yet covered by any source/)).toEqual([]);
  }, 240_000);

  it("DS-N2-6, DS-N2-8: a revision lowering one risk and raising none is accepted, one raising bad citations is refused with the prior kept, and the pass stops; a disagreement is reported with both positions and the better-supported one", async () => {
    const pages = { "nodejs.org/api/zod.html": A, "github.com/colinhacks/zod": B };
    const researcher: Turn[] = [
      [fetch("https://nodejs.org/api/zod.html"), fetch("https://github.com/colinhacks/zod")],
      "Zod validates email with z.string().email() [1]. Zod 4 moved it to z.email() [2].",
    ];
    const better =
      "Zod validates email with z.string().email() [1]. Zod 4 moved it to z.email() [2].";
    const { r, sent } = await deep(pages, researcher, [
      Q,
      `${better} It is the fastest validator [5].`,
      `${better}\nDISAGREEMENT: zod email check | z.string().email() [1] | z.email() [2]`,
      `${better} See also [9].`,
      "a third candidate that must never be asked for",
    ]);
    const a = answerOf(r.stdout) as {
      answer: string;
      badCitations: number[];
      critique: { accepted: boolean; reason: string }[];
      disagreements: {
        topic: string;
        positions: { stance: string; source: { kind: string; ref: string } }[];
        betterSupported: string;
        why: string;
      }[];
    };
    expect(a.critique).toEqual([
      { accepted: true, reason: "accepted: fewer unverified citations" },
      { accepted: false, reason: "rejected: more unverified citations" },
    ]);
    expect(a.answer).toBe(better);
    expect(a.badCitations).toEqual([]);
    // Stopped after the refused candidate: two of the effort's three were asked.
    expect(asked(sent, /You revise research answers/)).toHaveLength(2);
    // DS-N2-8: both positions, each with its source, and the verdict with its reason.
    expect(a.disagreements).toEqual([
      expect.objectContaining({
        topic: "zod email check",
        positions: [
          expect.objectContaining({
            stance: "z.string().email()",
            source: expect.objectContaining({
              kind: "documentation",
              ref: "https://nodejs.org/api/zod.html",
            }),
          }),
          expect.objectContaining({
            stance: "z.email()",
            source: expect.objectContaining({
              kind: "repository",
              ref: "https://github.com/colinhacks/zod",
            }),
          }),
        ],
        betterSupported: "z.string().email()",
        why: "a documentation source outranks a repository one",
      }),
    ]);

    // As a person reads it: each position's tier, and the better-supported one.
    const shown = await deep(
      pages,
      researcher,
      [
        Q,
        better,
        `${better}\nDISAGREEMENT: zod email check | z.string().email() [1] | z.email() [2]`,
        better,
      ],
      false,
    );
    expect(shown.r.stdout).toMatch(
      /## Where sources disagree\n\n\*\*zod email check\*\*\n- z\.string\(\)\.email\(\) — documentation \(primary\), https:\/\/nodejs\.org\/api\/zod\.html\n- z\.email\(\) — repository \(secondary\), https:\/\/github\.com\/colinhacks\/zod\nBetter supported: z\.string\(\)\.email\(\), because a documentation source outranks a repository one\./,
    );
  }, 240_000);

  it("DS-N2-6: when no candidate lowers any component of the risk, the draft stands and the pass stops", async () => {
    const better =
      "Zod validates email with z.string().email() [1]. Zod 4 moved it to z.email() [2].";
    const { r, sent } = await deep(
      { "nodejs.org/api/zod.html": A, "github.com/colinhacks/zod": B },
      [
        [fetch("https://nodejs.org/api/zod.html"), fetch("https://github.com/colinhacks/zod")],
        better,
      ],
      [Q, better, better, "never asked"],
    );
    const a = answerOf(r.stdout) as {
      answer: string;
      critique: { accepted: boolean; reason: string }[];
    };
    expect(a.critique).toEqual([{ accepted: false, reason: "rejected: no measured improvement" }]);
    expect(a.answer).toBe(better);
    expect(asked(sent, /You revise research answers/)).toHaveLength(1);
  }, 240_000);
});
