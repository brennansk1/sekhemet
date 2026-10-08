import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CardStore } from "@sekhemet/kernel";
import { describe, expect, it } from "vitest";
import { openLocalLedger } from "../src/ledger_cmds.js";
import { cli, g2Dirs, g2Env, ledgerRows } from "./support/g2_cli.js";
import { SCRIPTED_MODEL, type Turn, scriptEnv } from "./support/g2_model.js";
import { g2Project, gatesToml, writeTree } from "./support/g2_project.js";

/**
 * Mutation scores that cannot lie, through their doors (measurement §2 M10,
 * MS-M10-1 to MS-M10-4; FINISH_LINE_PLAN C2d): `sekhemet improve --mutants`
 * spawned over a real repository whose accepted commit the ledger names, and
 * the built-in mutation gate on a card run by a spawned `sekhemet queue`. The
 * project's own test gate runs every mutant, in a real git worktree.
 *
 * The binary under test is `apps/harness/dist/index.js`, spawned by
 * `support/g2_cli.ts`.
 */

/** A repository whose last commit, holding `files`, is card c1's accepted change. */
async function accepted(
  cwd: string,
  testGate: string[],
  files: Record<string, string>,
  // The block `sekhemet init` writes: the checks are tracked, state is not.
  gitignore = ".sekhemet/*\n!.sekhemet/gates.toml\n",
): Promise<string> {
  const git = (...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Jane Doe");
  git("config", "user.email", "jane@example.com");
  writeTree(cwd, {
    ".gitignore": gitignore,
    ".sekhemet/gates.toml": gatesToml(testGate),
    "README.md": "# app\n",
  });
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  writeTree(cwd, files);
  git("add", "-A");
  git("commit", "-q", "-m", "feat: change\n\nCard: c1");
  const sha = git("rev-parse", "HEAD");
  const { db, log } = openLocalLedger(cwd);
  try {
    const store = new CardStore(db, log);
    await store.createCard({ id: "c1", tier: "task", title: "Change" });
    await store.updateCardStatus("c1", "done", "accepted", "harness", { override: true });
    await store.recordEvent({
      type: "card/accepted",
      cardId: "c1",
      actor: "human",
      payload: { id: "c1", sha },
    });
  } finally {
    db.close();
  }
  return sha;
}

const MAX = { "src/max.js": "export function max(a, b) {\n  return a > b ? a : b;\n}\n" };
const PASS = ["-e", "process.exit(0)"];

function mutationEvent(cwd: string) {
  return ledgerRows(cwd).find((x) => x.type === "improve/mutation")?.payload;
}

describe("sekhemet improve --mutants (MS-M10-1 to MS-M10-3)", () => {
  it("MS-M10-1: refuses to score when the tests fail on the unmutated checkout, and says why", async () => {
    const where = g2Dirs();
    const sha = await accepted(where.cwd, ["-e", "process.exit(1)"], MAX);
    const r = await cli(["improve", "--mutants"], { cwd: where.cwd, env: g2Env(where.home) });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(
      `mutation c1 ${sha.slice(0, 10)}: not scored: the tests fail on the unmutated checkout of ${sha.slice(0, 10)}, so no mutant can be scored`,
    );
    expect(mutationEvent(where.cwd)).toMatchObject({ score: null, total: 0 });
  }, 120_000);

  it("MS-M10-2: a change with no mutable lines records the score as not applicable, not 1", async () => {
    const where = g2Dirs();
    await accepted(where.cwd, PASS, { "src/names.js": 'export const name = "x";\n' });
    const r = await cli(["improve", "--mutants"], { cwd: where.cwd, env: g2Env(where.home) });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(
      /mutation c1 [0-9a-f]{10}: 0\/0 killed \(score not applicable: nothing to mutate\)/,
    );
    const event = mutationEvent(where.cwd);
    expect(event?.score).toBeNull();
    expect(event?.score).not.toBe(1);
  }, 120_000);

  it("MS-M10-3: reports changed files in a language it cannot mutate as not measured", async () => {
    const where = g2Dirs();
    await accepted(where.cwd, PASS, {
      ...MAX,
      "tools/check.py": "def ok(x):\n    return x > 1\n",
      "native/lib.rs": "pub fn ok(x: i32) -> bool { x > 1 }\n",
      "docs/notes.md": "# notes\n",
    });
    const r = await cli(["improve", "--mutants", "--max-mutants", "2"], {
      cwd: where.cwd,
      env: g2Env(where.home),
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/; not measured \(language\): native\/lib\.rs, tools\/check\.py/);
    expect(r.stdout).not.toMatch(/not measured[^\n]*(notes\.md|max\.js)/);
  }, 120_000);
});

describe("sekhemet improve --mutants where gates.toml is not tracked (C2d finding)", () => {
  it("scores the change with the repository's gates.toml when `.sekhemet/` is wholly ignored, rather than failing its integrity check in the checkout", async () => {
    const where = g2Dirs();
    const sha = await accepted(where.cwd, PASS, MAX, ".sekhemet/\n");
    const r = await cli(["improve", "--mutants", "--max-mutants", "2"], {
      cwd: where.cwd,
      env: g2Env(where.home),
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`mutation c1 ${sha.slice(0, 10)}: \\d+/\\d+ killed`));
    expect(r.stdout + r.stderr).not.toMatch(/not scored|integrity|changed during the run/i);
  }, 120_000);
});

describe("the built-in mutation gate on a card (MS-M10-4)", () => {
  const write: Turn = [
    {
      name: "write_file",
      arguments: {
        path: "src/a.js",
        content: "export const a = 1;\nexport const big = (n) => n > 10;\n",
      },
    },
    { name: "finish_card" },
  ];

  async function run(gate: string[]) {
    const where = g2Dirs();
    const p = await g2Project(where, {
      files: {
        "src/a.js": "export const a = 1;\n",
        ".sekhemet/gates.toml": gatesToml(gate).replace(
          "[project]\n",
          "[project]\nmutation = true\n",
        ),
      },
      cards: [
        {
          id: "c1",
          tier: "story",
          title: "Add big",
          scopeFiles: ["src/a.js"],
          stepBudget: 1,
          spec: "Add big",
        },
      ],
    });
    const r = await cli(["queue", "--worker", SCRIPTED_MODEL], {
      cwd: p.repo,
      preload: p.preload,
      env: { ...p.env, ...scriptEnv(p.record, { worker: [write] }) },
      timeoutMs: 120_000,
    });
    const dir = join(p.repo, ".sekhemet", "evidence");
    const bundle = readdirSync(dir).map((f) =>
      JSON.parse(readFileSync(join(dir, f), "utf8")),
    )[0] as {
      rungResults: { gate: string; passed: boolean; mutation?: Record<string, unknown> }[];
    };
    return { r, p, mutation: bundle.rungResults.find((x) => x.gate === "mutation") };
  }

  it("MS-M10-4: a card's mutation gate scores mutants only against tests that pass on the unmutated change — failing tests never score every mutant killed", async () => {
    // Tests that fail on the unmutated change: the card fails its test rung
    // and no mutation score is recorded — never the 1.0 that counting every
    // mutant as killed would give.
    const failing = await run(["-e", "process.exit(1)"]);
    expect(failing.r.stdout, failing.r.stderr).toMatch(/FAILED/);
    expect(failing.mutation?.mutation?.score ?? null).toBeNull();
    expect(failing.mutation?.mutation?.killed ?? 0).toBe(0);

    // Tests that pass unmutated and kill the `>=` mutant: 1 of 1.
    const kills = [
      "-e",
      "const s = require('fs').readFileSync('src/a.js', 'utf8'); process.exit(!s.includes('big') || s.includes('n > 10') ? 0 : 1);",
    ];
    const scored = await run(kills);
    expect(scored.r.stdout).toMatch(/PASSED/);
    expect(scored.mutation?.mutation).toMatchObject({ score: 1, killed: 1, total: 1 });

    // Tests that pass unmutated and never look at `big`: the mutant survives, 0 of 1.
    const blind = await run(["-e", "process.exit(0)"]);
    expect(blind.r.stdout).toMatch(/PASSED/);
    expect(blind.mutation?.mutation).toMatchObject({ score: 0, killed: 0, total: 1 });
  }, 240_000);
});
