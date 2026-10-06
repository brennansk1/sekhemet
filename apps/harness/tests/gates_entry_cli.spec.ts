import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { cli, ledgerRows } from "./support/g2_cli.js";
import { type GateProject, gateProject } from "./support/g4_gate.js";
import { gateCard } from "./support/g4_queue.js";

/**
 * The gates as a person meets them through `sekhemet gate <card>` (FINISH_LINE_PLAN
 * C2d; FINDINGS_C1 TST-01): the built binary (`apps/harness/dist/index.js`,
 * spawned by `support/g2_cli.ts`) runs the card run's own verification over the
 * card's real worktree in a real git repository with a real ledger (gates
 * rule 8, T1), and prints each gate's outcome and the ranked failures with
 * their remedies. Nothing is called in this process; every assertion is on what
 * the command printed, its exit code, or the files and ledger it left.
 */

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const VITEST = join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");

/** A declared gate that always passes: the declared layer is not what these tests judge. */
const LINT = `[[gate]]\nid = "lint"\nrung = "lint"\ncommand = "sh"\nargs = ["-c", "exit 0"]\nparser = "generic"\n`;

/** The printed outcome line of `gate`: its mark (✓ ✗ ! -) and its reason. */
function outcome(out: string, gate: string): { mark: string; reason: string } | undefined {
  const re = new RegExp(
    `^\\s+([✓✗!-]) ${gate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(\\d+ ms\\)(?: — (.*))?$`,
    "m",
  );
  const m = re.exec(out);
  return m ? { mark: m[1] as string, reason: m[2] ?? "" } : undefined;
}

/** The printed failures, in the order they reach the Worker: `[gate] first line` and its fix. */
function failures(err: string): { gate: string; text: string; fix: string }[] {
  const out: { gate: string; text: string; fix: string }[] = [];
  for (const line of err.split("\n")) {
    const m = /^ {2}\[([^\]]+)\] (.*)$/.exec(line);
    if (m) out.push({ gate: m[1] as string, text: m[2] as string, fix: "" });
    const f = /^ {6}fix: (.*)$/.exec(line);
    const last = out[out.length - 1];
    if (f && last) last.fix = f[1] as string;
  }
  return out;
}

const run = async (p: GateProject) => {
  const r = await gateCard(p);
  return { ...r, all: `${r.stdout}\n${r.stderr}` };
};

describe("fail closed: a gate that could not run is never a pass (gates rule 9)", () => {
  it("GT-T1-11: when git cannot produce the card's diff, the diff-based layers print not-run with the reason, none prints a pass, and no gate that was never declared appears", async () => {
    const p = await gateProject({
      files: {
        ".sekhemet/gates.toml": LINT,
        "src/main.ts": 'import { a } from "./a.js";\nconsole.log(a);\n',
        "src/a.ts": "",
      },
      card: { "src/a.ts": "export const a = 1;\n" },
    });
    // The card's file cannot be read, so git cannot diff it.
    chmodSync(join(p.worktree, "src", "a.ts"), 0o000);
    try {
      const r = await run(p);
      expect(r.status, r.all).toBe(1);
      for (const g of ["integrity", "bounds", "secrets", "dependencies", "hygiene", "semgrep"]) {
        const o = outcome(r.stdout, g);
        expect(o?.mark, `${g}\n${r.all}`).toBe("!");
        expect(o?.reason).toBe("git could not produce the diff");
      }
      // A skipped layer says why; no parse gate is invented when none is declared.
      expect(outcome(r.stdout, "osv")).toEqual({
        mark: "-",
        reason: "osv-scanner is not installed",
      });
      expect(outcome(r.stdout, "parse")).toBeUndefined();
      expect(r.stdout).not.toContain("All checks passed");
    } finally {
      chmodSync(join(p.worktree, "src", "a.ts"), 0o644);
    }
  });

  it("GT-T1-7: a gate whose declared need the host cannot provide is unavailable naming the need, never starts, and fails the card", async () => {
    const p = await gateProject({ files: {} });
    // Were it started, it would leave this file in the worktree it runs in.
    const marker = join(p.worktree, "db-tests-ran");
    writeFileSync(
      join(p.repo, ".sekhemet", "gates.toml"),
      `[[gate]]\nid = "db-tests"\nrung = "test"\ncommand = "sh"\nargs = ["-c", "touch db-tests-ran"]\nparser = "generic"\nneeds = ["postgres", "env:SEKHEMET_NEVER_SET"]\n`,
    );
    const r = await run(p);
    expect(r.status, r.all).toBe(1);
    expect(outcome(r.stdout, "db-tests")).toEqual({
      mark: "!",
      reason: "needs postgres, env:SEKHEMET_NEVER_SET, which this host does not provide",
    });
    expect(existsSync(marker)).toBe(false);
    const [f] = failures(r.stderr);
    expect(f?.gate).toBe("db-tests");
    // Not the card's failure: the remedy says so.
    expect(f?.fix).toMatch(/not the card's work/);
  });
});

describe("gates.toml as a person writes it (GT-T1-6)", () => {
  it("GT-T1-6: an unknown rung, layer or parser is a warning naming the key and the value", async () => {
    const p = await gateProject({
      files: {
        ".sekhemet/gates.toml": `[[gate]]\nid = "odd"\nrung = "sideways"\nlayer = "astral"\ncommand = "sh"\nargs = ["-c", "exit 0"]\nparser = "tealeaves"\n`,
      },
    });
    const r = await run(p);
    expect(r.status, r.all).toBe(0);
    const warnings = r.stdout.split("\n").filter((l) => l.startsWith("  warning: "));
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/gate "odd": unknown parser = "tealeaves"/),
        expect.stringMatching(/gate "odd": unknown rung = "sideways"/),
        expect.stringMatching(/gate "odd": unknown layer = "astral"/),
      ]),
    );
  });
});

describe("reachability through the source index (GT-T2, IX)", () => {
  it("GT-T2-1: an export used only as ns.name through `import * as ns`, or re-exported by an entry point's `export *`, is reachable; one nothing uses is not", async () => {
    const p = await gateProject({
      files: {
        ".sekhemet/gates.toml": LINT,
        "src/index.ts": 'export * from "./util.js";\n',
        "src/util.ts": "",
        "src/ns.ts": "",
        "src/main.ts": 'import * as ns from "./ns.js";\nconsole.log(ns.size);\n',
        "src/lonely.ts": "",
      },
      card: {
        "src/util.ts": "export const pad = 1;\n",
        "src/ns.ts": "export const size = 2;\n",
        "src/lonely.ts": "export const orphan = 3;\n",
      },
    });
    const r = await run(p);
    expect(r.status, r.all).toBe(1);
    expect(outcome(r.stdout, "reachability")?.mark).toBe("✗");
    expect(failures(r.stderr).map((f) => f.text)).toEqual([
      "src/lonely.ts: export orphan is used by nothing in production and required by no acceptance test",
    ]);
  });

  it("GT-T2-5: an export production code reaches only through a dynamic import() is reachable; a dynamic import in the card's own unit test does not count", async () => {
    const p = await gateProject({
      files: {
        ".sekhemet/gates.toml": LINT,
        "src/main.ts":
          'export async function boot() {\n  const m = await import("./lazy.js");\n  return m;\n}\n',
        "src/lazy.ts": "",
        "src/util.ts": "",
      },
      card: {
        "src/lazy.ts": "export const later = 1;\nexport function load() { return later; }\n",
        "src/util.ts": "export const pad = 1;\n",
        "tests/util.spec.ts":
          'import { it } from "vitest";\nit("pads", async () => { const { pad } = await import("../src/util.js"); void pad; });\n',
      },
    });
    const r = await run(p);
    expect(r.status, r.all).toBe(1);
    expect(failures(r.stderr).map((f) => f.text)).toEqual([
      "src/util.ts: export pad is used by nothing in production and required by no acceptance test",
    ]);
  });

  it("IX-5: an export a workspace package's declared entry point re-exports is a public surface", async () => {
    const p = await gateProject({
      files: {
        ".sekhemet/gates.toml": LINT,
        "package.json": '{ "name": "root", "private": true }\n',
        "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
        "packages/a/package.json":
          '{ "name": "@x/a", "version": "1.0.0", "exports": { ".": "./src/api.ts" } }\n',
        "packages/a/src/api.ts": "",
        "packages/a/src/util.ts": "",
      },
      card: {
        "packages/a/src/api.ts": 'export * from "./util.js";\n',
        "packages/a/src/util.ts": "export const pad = 1;\n",
      },
      cardInput: { scopeFiles: ["packages/**"] },
    });
    const r = await run(p);
    expect(outcome(r.stdout, "reachability")?.mark, r.all).toBe("✓");
    expect(r.status, r.all).toBe(0);
  });

  it("IX-2: a module specifier resolves to a file or an external package, never a guess — a bare `cli` is the package, `../cli` is the project's file", async () => {
    const p = await gateProject({
      files: {
        ".sekhemet/gates.toml": LINT,
        ".sekhemet/brief.md":
          "# Brief\n\n## Invariants\n\n- `src/db/` does not import `src/cli.ts`\n",
        "src/cli.ts": "export const run = 1;\n",
      },
      card: {
        "src/db/a.ts": 'import { run } from "cli";\nexport const viaPackage = run;\n',
        "src/db/b.ts": 'import { run } from "../cli";\nexport const viaFile = run;\n',
      },
      cardInput: { spec: "Export viaPackage and viaFile from src/db." },
    });
    const r = await run(p);
    expect(r.status, r.all).toBe(1);
    expect(outcome(r.stdout, "architecture")?.mark).toBe("✗");
    const arch = failures(r.stderr).filter((f) => f.gate === "architecture");
    expect(arch.map((f) => f.text)).toEqual([
      'src/db/b.ts: breaks the brief\'s invariant "`src/db/` does not import `src/cli.ts`"',
    ]);
  });

  it("GT-IX-1, IX-1: a changed file that does not parse is the Worker's to fix, with the syntax error; another's broken file is a named failure routed to a person, never a pass", async () => {
    const own = await gateProject({
      files: { ".sekhemet/gates.toml": LINT, "src/util.ts": "" },
      card: { "src/util.ts": "export const pad = (;\n" },
    });
    const r1 = await run(own);
    expect(r1.status, r1.all).toBe(1);
    expect(outcome(r1.stdout, "reachability")?.mark).toBe("✗");
    const [syntax] = failures(r1.stderr);
    expect(syntax?.text).toMatch(
      /^src\/util\.ts: does not parse cleanly \(line 1: .+\), so its exports cannot be judged$/,
    );
    expect(syntax?.fix).toMatch(/Fix the syntax error at line 1/);

    const others = await gateProject({
      files: {
        ".sekhemet/gates.toml": LINT,
        "src/util.ts": "",
        "src/app.ts": 'import { pad } from "./util.js";\nlog(pad;\n',
      },
      card: { "src/util.ts": "export const pad = 1;\n" },
    });
    const r2 = await run(others);
    expect(r2.status, r2.all).toBe(1);
    expect(outcome(r2.stdout, "reachability")?.mark).toBe("✗");
    const fs2 = failures(r2.stderr);
    expect(fs2).toHaveLength(1);
    expect(fs2[0]?.text).toMatch(
      /^src\/app\.ts: does not parse cleanly \(line 2: .+\); the issue did not change it, so the verdict on what it uses is partial$/,
    );
    expect(fs2[0]?.fix).toMatch(/Nothing for you to change here: a person decides/);
  });

  it("GT-IX-1, GT-BF-2: after `onboard` records the baseline, a partly read file it listed is not counted and a pre-existing type error is not the card's; a new one is", async () => {
    const CHECK = `const fs = require("node:fs");
const lines = fs.existsSync("errors.txt") ? fs.readFileSync("errors.txt", "utf8").split("\\n").filter(Boolean) : [];
for (const l of lines) console.log(l);
process.exit(lines.length ? 2 : 0);
`;
    const OLD = "src/old.ts(2,10): error TS2304: Cannot find name 'missing'.";
    const p = await gateProject({
      files: {
        ".sekhemet/gates.toml": `[[gate]]\nid = "typecheck"\nrung = "typecheck"\ncommand = "node"\nargs = ["check.cjs"]\nparser = "tsc"\n`,
        "check.cjs": CHECK,
        "errors.txt": `${OLD}\n`,
        "src/old.ts": "export function old(): number {\n  return missing;\n}\n",
        "src/util.ts": "",
        "src/app.ts": 'import { pad } from "./util.js";\nlog(pad;\n',
      },
      card: { "src/util.ts": "export const pad = 1;\n" },
    });
    const onboard = await cli(["onboard", "--trust"], {
      cwd: p.repo,
      env: p.env,
      timeoutMs: 120_000,
    });
    expect(onboard.status, `${onboard.stdout}\n${onboard.stderr}`).toBe(0);
    expect(onboard.stdout).toMatch(/8\. Baseline: 1 pre-existing finding/);
    const baseline = ledgerRows(p.repo).find((e) => e.type === "project/baseline");
    expect(baseline?.payload.partial).toEqual([
      { file: "src/app.ts", reason: expect.stringMatching(/^line 2: /) },
    ]);
    const same = await run(p);
    expect(same.status, same.all).toBe(0);
    expect(outcome(same.stdout, "typecheck")?.mark).toBe("✓");
    expect(outcome(same.stdout, "reachability")?.mark).toBe("✓");

    // The card adds a type error of its own: only that one is reported.
    const NEW = "src/util.ts(1,14): error TS2304: Cannot find name 'other'.";
    writeFileSync(join(p.worktree, "errors.txt"), `${OLD}\n${NEW}\n`);
    const added = await run(p);
    expect(added.status, added.all).toBe(1);
    expect(failures(added.stderr).map((f) => f.text)).toEqual([
      "src/util.ts:1:14 TS2304: Cannot find name 'other'.",
    ]);
  });
});

describe("judge what the card wrote, against the right base (GT-N2)", () => {
  it("GT-N2-2: a missing changelog entry is an advisory when CHANGELOG.md is outside the card's scope, and a failure when it is in scope", async () => {
    const files = {
      ".sekhemet/gates.toml": LINT,
      "CHANGELOG.md": "# Changes\n",
      "src/main.ts": 'import { a } from "./a.js";\nconsole.log(a);\n',
      "src/a.ts": "",
    };
    const out = await run(
      await gateProject({ files, card: { "src/a.ts": "export const a = 1;\n" } }),
    );
    expect(out.status, out.all).toBe(0);
    expect(out.stdout).toMatch(
      /advisory: hygiene: source changed but CHANGELOG\.md has no entry for it; CHANGELOG\.md is outside this card's scope, so a person adds one/,
    );
    expect(outcome(out.stdout, "hygiene")?.mark).toBe("✓");

    const inScope = await run(
      await gateProject({
        files,
        card: { "src/a.ts": "export const a = 1;\n" },
        cardInput: { scopeFiles: ["src/**", "CHANGELOG.md"] },
      }),
    );
    expect(inScope.status, inScope.all).toBe(1);
    expect(outcome(inScope.stdout, "hygiene")?.mark).toBe("✗");
    expect(failures(inScope.stderr)[0]?.text).toBe(
      "Source changed but CHANGELOG.md has no entry for it",
    );
  });

  it('GT-N2-3: with `base_branch = "master"` the card is verified against master, and a base test it removed is a regression naming master', async () => {
    const p = await gateProject({
      branch: "master",
      files: {
        ".sekhemet/gates.toml": `[project]\nbase_branch = "master"\n\n${LINT}`,
        "src/a.ts": "export const a = 1;\n",
        "tests/keep.spec.ts":
          'import { expect, it } from "vitest";\nit("keeps", () => { expect(1 + 1).toBe(2); });\n',
      },
      removed: ["tests/keep.spec.ts"],
    });
    const r = await run(p);
    expect(r.stdout).toMatch(/Verifying c1 against master in /);
    expect(r.status, r.all).toBe(1);
    expect(outcome(r.stdout, "regression")?.mark).toBe("✗");
    const [f] = failures(r.stderr);
    expect(f?.gate).toBe("regression");
    expect(`${f?.text} ${f?.fix}`).toContain("tests/keep.spec.ts");
    expect(r.all).toContain("master");
  });

  it("GT-N2-4: a new file the card created and did not commit that breaks an invariant fails the architecture gate", async () => {
    const p = await gateProject({
      files: {
        ".sekhemet/gates.toml": LINT,
        ".sekhemet/brief.md":
          "# Brief\n\n## Invariants\n\n- `src/db/` does not import `src/cli.ts`\n",
        "src/cli.ts": "export const cli = 1;\n",
        "src/db/store.ts": "export const store = 1;\n",
      },
      card: { "src/db/new.ts": 'import { cli } from "../cli.js";\nexport const n = cli;\n' },
      cardInput: { spec: "Export n from src/db/new.ts." },
    });
    // Untracked in the worktree: never added to git.
    expect(
      execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
        cwd: p.worktree,
        encoding: "utf8",
      }),
    ).toBe("?? src/db/new.ts\n");
    const r = await run(p);
    expect(r.status, r.all).toBe(1);
    expect(outcome(r.stdout, "architecture")?.mark).toBe("✗");
    expect(failures(r.stderr)).toEqual([
      expect.objectContaining({
        gate: "architecture",
        text: 'src/db/new.ts: breaks the brief\'s invariant "`src/db/` does not import `src/cli.ts`"',
      }),
    ]);
  });

  it('GT-T2-2: a type-only import, a comment or a local variable naming X is not a second definition under "is defined only in"; a real one is', async () => {
    const files = {
      ".sekhemet/gates.toml": LINT,
      ".sekhemet/brief.md":
        "# Brief\n\n## Invariants\n\n- `Store` is defined only in `src/db/store.ts`\n",
      "src/db/store.ts": "export interface Store {\n  name: string;\n}\n",
    };
    const fine = await run(
      await gateProject({
        files,
        card: {
          "src/ui.ts":
            'import { type Store } from "./db/store.js";\n// Store is the database handle the page shows.\nexport function show(s: Store): string {\n  const Store = "store: ";\n  return Store + s.name;\n}\n',
        },
        cardInput: { spec: "Export show from src/ui.ts." },
      }),
    );
    expect(fine.status, fine.all).toBe(0);
    expect(outcome(fine.stdout, "architecture")?.mark).toBe("✓");

    const twice = await run(
      await gateProject({
        files,
        card: { "src/other.ts": 'export class Store {\n  name = "x";\n}\n' },
        cardInput: { spec: "Export Store from src/other.ts." },
      }),
    );
    expect(twice.status, twice.all).toBe(1);
    expect(failures(twice.stderr).map((f) => `${f.gate} ${f.text.split(":")[0]}`)).toEqual([
      "architecture src/other.ts",
    ]);
  });
});

describe("the repair contract: remedies and their order (GT-M6)", () => {
  const tscGate = (lines: string[]) =>
    `[[gate]]\nid = "typecheck"\nrung = "typecheck"\ncommand = "node"\nargs = ["-e", ${JSON.stringify(
      `console.log(${JSON.stringify(lines.join("\n"))}); process.exit(2)`,
    )}]\nparser = "tsc"\n`;

  it("GT-M6-3: TS2305, TS2339 and TS2304 list the real exports, members or the exporting module inline, and no remedy tells the model to read a file", async () => {
    const p = await gateProject({
      files: {
        ".sekhemet/gates.toml": tscGate([
          "src/b.ts(1,10): error TS2305: Module '\"./a.js\"' has no exported member 'bee'.",
          "src/b.ts(3,11): error TS2339: Property 'z' does not exist on type 'Point'.",
          "src/b.ts(4,13): error TS2304: Cannot find name 'zed'.",
        ]),
        "src/a.ts":
          "export const alpha = 1;\nexport function beta(): number {\n  return 2;\n}\nexport interface Point {\n  x: number;\n  y: number;\n}\n",
        "src/zed.ts": "export const zed = 3;\n",
      },
      card: {
        "src/b.ts":
          'import { alpha, bee, type Point } from "./a.js";\nconst p: Point = { x: 1, y: 2 };\nconsole.log(p.z, alpha, bee);\nconsole.log(zed);\n',
      },
    });
    const r = await run(p);
    expect(r.status, r.all).toBe(1);
    const fs = failures(r.stderr);
    expect(fs).toHaveLength(3);
    const by = (code: string) => fs.find((f) => f.text.includes(code));
    expect(by("TS2305")?.fix).toMatch(
      /src\/a\.ts does not export bee\. It exports exactly: Point, alpha, beta\./,
    );
    expect(by("TS2339")?.fix).toMatch(/^Point has no member z\. Its members are exactly: x, y\./);
    expect(by("TS2304")?.fix).toMatch(
      /^zed is not in scope\. src\/zed\.ts exports zed: add `import \{ zed \} from "\.\/zed\.js";`/,
    );
    for (const f of fs) expect(f.fix, f.text).not.toMatch(/\bread\b/i);
  });

  it("GT-M6-7: of two typecheck failures in A and in B, where B imports A, A's is ranked first", async () => {
    const p = await gateProject({
      files: {
        ".sekhemet/gates.toml": tscGate([
          "src/b.ts(1,10): error TS2305: Module '\"./a.js\"' has no exported member 'bee'.",
          "src/a.ts(2,1): error TS2304: Cannot find name 'zed'.",
        ]),
        "src/a.ts": "export const alpha = 1;\n",
        "src/b.ts": 'import { alpha } from "./a.js";\nconsole.log(alpha);\n',
      },
      card: { "src/b.ts": 'import { alpha, bee } from "./a.js";\nconsole.log(alpha, bee);\n' },
    });
    const r = await run(p);
    expect(r.status, r.all).toBe(1);
    expect(failures(r.stderr).map((f) => f.text.split(":")[0])).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

describe("gate economics and workspaces (GT-N3, GT-BF)", () => {
  it("GT-N3-3: every static gate runs before any functional gate, whatever order gates.toml declares them in", async () => {
    const p = await gateProject({ files: {} });
    // Each gate appends its id to a log in the worktree it runs in (ignored by git).
    const log = join(p.worktree, ".sekhemet", "gate-order.log");
    const gate = (id: string, rung: string) =>
      `[[gate]]\nid = "${id}"\nrung = "${rung}"\ncommand = "sh"\nargs = ["-c", "mkdir -p .sekhemet && echo ${id} >> .sekhemet/gate-order.log"]\nparser = "generic"\n`;
    writeFileSync(
      join(p.repo, ".sekhemet", "gates.toml"),
      gate("unit", "test") +
        gate("e2e", "test") +
        gate("lint", "lint") +
        gate("types", "typecheck"),
    );
    const r = await run(p);
    expect(r.status, r.all).toBe(0);
    const order = readFileSync(log, "utf8").split("\n").filter(Boolean);
    expect(order.slice(0, 2).sort()).toEqual(["lint", "types"]);
    expect(order.slice(2).sort()).toEqual(["e2e", "unit"]);
  });

  it("GT-BF-1: a base test the card declares superseded, its new version staged, is not a regression; undeclared, it is", async () => {
    const files = {
      "package.json": '{ "name": "s", "type": "module", "private": true }\n',
      ".sekhemet/gates.toml": `[[gate]]\nid = "unit"\nrung = "test"\ncommand = "node"\nargs = [${JSON.stringify(VITEST)}, "run", "--reporter=default"]\nparser = "vitest"\ntimeout_s = 120\n`,
      "src/greet.ts": "export const greet = (n: string): string => `hi ${n}`;\n",
      "tests/greet.spec.ts":
        'import { expect, it } from "vitest";\nimport { greet } from "../src/greet.js";\nit("greets", () => { expect(greet("a")).toBe("hi a"); });\nit("keeps the name", () => { expect(greet("a")).toContain("a"); });\n',
    };
    const card = {
      "src/greet.ts": "export const greet = (n: string): string => `hello ${n}`;\n",
      "tests/greet_hello.spec.ts":
        'import { expect, it } from "vitest";\nimport { greet } from "../src/greet.js";\nit("greets", () => { expect(greet("a")).toBe("hello a"); });\n',
    };
    const declared = await run(
      await gateProject({
        files,
        card,
        cardInput: {
          scopeFiles: ["src/**", "tests/**"],
          acceptanceTests: ["tests/greet_hello.spec.ts"],
          supersedes: ["tests/greet.spec.ts > greets"],
        },
      }),
    );
    expect(declared.status, declared.all).toBe(0);
    expect(outcome(declared.stdout, "regression")?.mark).toBe("✓");
    expect(outcome(declared.stdout, "unit")?.mark).toBe("✓");

    const undeclared = await run(
      await gateProject({
        files,
        card,
        cardInput: {
          scopeFiles: ["src/**", "tests/**"],
          acceptanceTests: ["tests/greet_hello.spec.ts"],
        },
      }),
    );
    expect(undeclared.status, undeclared.all).toBe(1);
    expect(failures(undeclared.stderr).filter((f) => f.gate === "regression")).toHaveLength(1);
  });

  it("GT-BF-4: a card changing a workspace package runs that package's tests, then its dependents', in build order, before the rest", async () => {
    const RUNNER = `import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
mkdirSync(join(ROOT, ".log"), { recursive: true });
const args = process.argv.slice(2).filter((a) => !a.startsWith("-") && a !== "run");
const walk = (d) => readdirSync(d).flatMap((n) => {
  if (n === "node_modules" || n.startsWith(".")) return [];
  const p = join(d, n);
  return statSync(p).isDirectory() ? walk(p) : /\\.spec\\.ts$/.test(n) ? [relative(process.cwd(), p)] : [];
});
const files = args.length ? args : walk(process.cwd());
for (const f of files) appendFileSync(join(ROOT, ".log", "runs"), relative(ROOT, join(process.cwd(), f)) + "\\n");
console.log(" Test Files  " + files.length + " passed (" + files.length + ")");
console.log("      Tests  " + files.length + " passed (" + files.length + ")");
`;
    const pkg = (name: string, deps: Record<string, string>) =>
      JSON.stringify({
        name,
        version: "1.0.0",
        dependencies: deps,
        scripts: { test: "node ../../tools/vitest.mjs run" },
      });
    const p = await gateProject({
      files: {
        "package.json": '{ "name": "root", "private": true, "type": "module" }\n',
        "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
        ".gitignore": ".log/\n.sekhemet/\nnode_modules/\n",
        ".sekhemet/gates.toml": `[[gate]]\nid = "unit"\nrung = "test"\ncommand = "node"\nargs = ["tools/vitest.mjs", "run"]\nparser = "vitest"\ntimeout_s = 120\n`,
        "tools/vitest.mjs": RUNNER,
        "packages/a/package.json": pkg("@x/a", {}),
        "packages/a/src/index.ts": 'export const greeting = "hi";\n',
        "packages/a/tests/a1.spec.ts": "// a\n",
        "packages/b/package.json": pkg("@x/b", { "@x/a": "workspace:*" }),
        "packages/b/src/index.ts": 'export const b = "b";\n',
        "packages/b/tests/b1.spec.ts": "// b\n",
        "packages/c/package.json": pkg("@x/c", {}),
        "packages/c/src/index.ts": 'export const c = "c";\n',
        "packages/c/tests/c1.spec.ts": "// c\n",
      },
      card: { "packages/a/src/index.ts": 'export const greeting = "hi"; // same\n' },
      cardInput: { scopeFiles: ["packages/**"] },
    });
    const r = await run(p);
    expect(r.status, r.all).toBe(0);
    const lines = r.stdout
      .split("\n")
      .filter((l) => /^\s+[✓✗!-] /.test(l))
      .map((l) => l.trim().split(" ")[1]);
    expect(lines.slice(0, 3)).toEqual(["@x/a:test", "@x/b:test", "unit"]);
    const runs = readFileSync(join(p.worktree, ".log", "runs"), "utf8")
      .split("\n")
      .filter(Boolean);
    expect(runs.indexOf("packages/a/tests/a1.spec.ts")).toBeLessThan(
      runs.indexOf("packages/b/tests/b1.spec.ts"),
    );
    expect(runs.indexOf("packages/b/tests/b1.spec.ts")).toBeLessThan(
      runs.indexOf("packages/c/tests/c1.spec.ts"),
    );
  });
});
