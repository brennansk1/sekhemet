import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadGatesConfig } from "@sekhemet/gates";
import { describe, expect, it } from "vitest";
import { cardZeroCard, installScaffoldGate } from "../src/card_zero.js";
import { cli, g2Dirs, g2Env, ledgerRows } from "./support/g2_cli.js";
import { SCRIPTED_MODEL, scriptEnv } from "./support/g2_model.js";
import { g2Project } from "./support/g2_project.js";

/**
 * The design stage through the command line (design-stage §2.1–2.2, DS-P2-1,
 * DS-P2-2, DS-P2-4, DS-N1-1, DS-N1-2, DS-N1-6, DS-N1-8;
 * FINISH_LINE_PLAN C2d): `sekhemet init`, `sekhemet plan` and `sekhemet queue`
 * spawned as the built binary in real repositories, planned without a model
 * and with research off, so nothing leaves the machine; the queue's Worker is
 * the recording scripted model.
 *
 * The binary under test is `apps/harness/dist/index.js`, spawned by
 * `support/g2_cli.ts`.
 */

async function planIn(spec: string) {
  const where = g2Dirs();
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: where.cwd });
  const r = await cli(["plan", spec, "--planner", "none"], {
    cwd: where.cwd,
    env: g2Env(where.home),
    timeoutMs: 120_000,
  });
  const briefPath = join(where.cwd, ".sekhemet", "brief.md");
  return {
    ...r,
    repo: where.cwd,
    brief: existsSync(briefPath) ? readFileSync(briefPath, "utf8") : undefined,
    rows: ledgerRows(where.cwd),
  };
}

const section = (brief: string, name: string) => {
  const at = brief.indexOf(`## ${name}`);
  const next = brief.indexOf("\n## ", at + 3);
  return brief.slice(at, next < 0 ? undefined : next);
};

describe("sekhemet init in an empty directory (DS-P2-4)", () => {
  it("DS-P2-4: offers to start a project by conversation instead of only saying no checks were found", async () => {
    const where = g2Dirs();
    const r = await cli(["init"], { cwd: where.cwd, env: g2Env(where.home) });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(
      /Nothing here yet, so there are no checks to find\. Start a project by conversation: tell Seshat on the board what you want built/,
    );
    expect(r.stdout).not.toMatch(/^No gates found\.?$/m);
  });
});

describe("sekhemet plan: how much the design stage writes down (DS-N1)", () => {
  it("DS-N1-1: small requests are not planned at the brief level", async () => {
    for (const spec of [
      "a CLI that shows my laptop charging status",
      "a static blog with author pages",
      "a password generator CLI",
      "a health check endpoint",
    ]) {
      const r = await planIn(spec);
      expect(r.status, `${spec}\n${r.stdout}${r.stderr}`).toBe(0);
      expect({ spec, brief: r.brief !== undefined }).toEqual({ spec, brief: false });
      expect(r.stdout).not.toMatch(/write the decisions down/);
    }
  }, 240_000);

  it("DS-N1-5: a Python script is planned in Python and never assumed TypeScript; an unstated stack is assumed TypeScript and said so", async () => {
    const py = await planIn("a Python script that renames photos");
    expect(py.status, py.stdout + py.stderr).toBe(0);
    expect(py.stdout).toMatch(
      /Building a Python script that renames photos\. In Python with pytest\./,
    );
    expect(py.stdout).not.toMatch(/TypeScript|\bNode\b|Vitest/);
    // The control: with no language stated, the assumption is named as one.
    const unstated = await planIn("build me a calculator");
    expect(unstated.status, unstated.stdout + unstated.stderr).toBe(0);
    expect(unstated.stdout).toMatch(/Assumed: TypeScript on Node with Vitest\./);
  }, 240_000);

  it("DS-N1-2, DS-N1-8: a sign-up site gets a brief with an identity riskiest assumption, and assumed non-goals said as assumed", async () => {
    const r = await planIn("a recipe website where people can sign up and save favourites");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(
      /Enough is at stake to write the decisions down: \.sekhemet\/brief\.md/,
    );
    expect(r.stdout).toMatch(/Riskiest assumption: Only the right person gets in/);
    if (!r.brief) throw new Error("no brief written");
    expect(section(r.brief, "Riskiest assumption")).toMatch(
      /Only the right person gets in: a session cannot be forged/,
    );
    // DS-N1-8: no non-goals were given: assumed, from what was said, not a template sentence.
    const nonGoals = section(r.brief, "Non-goals");
    expect(nonGoals).toMatch(/\*Not stated — assumed:\*/);
    expect(nonGoals).not.toMatch(/Anything else is a new card/);
    expect(section(r.brief, "Outcome")).toMatch(/sign up/);
    expect(section(r.brief, "Outcome")).toMatch(/save favourites/);
  }, 120_000);

  it("DS-N1-6: a hard rule after a quality word stays in the spec that is decomposed, as an invariant", async () => {
    const r = await planIn(
      "a billing service that charges customers monthly; it should be fast and scale to many users. A retried charge must never charge a customer twice.",
    );
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const epic = r.rows.find(
      (x) => x.type === "card/created" && x.payload.tier === "epic",
    )?.payload;
    expect(String(epic?.title)).toContain("A retried charge must never charge a customer twice");
    if (!r.brief) throw new Error("no brief written");
    expect(r.brief).toContain("A retried charge must never charge a customer twice");
    expect(r.stdout).toContain("A retried charge must never charge a customer twice");
  }, 120_000);
});

describe("sekhemet queue after card zero is Done: the gates come from the generator's output (DS-P2-1, DS-P2-2)", () => {
  /**
   * A repository whose card zero a person accepted, with the generator's
   * output committed and card one Ready: the queue's pass before card one
   * runs is where the project's checks are derived.
   */
  async function afterCardZero(stack: "typescript" | "python", files: Record<string, string>) {
    const scaffold = g2Dirs();
    installScaffoldGate(scaffold.cwd, stack);
    const gates = readFileSync(join(scaffold.cwd, ".sekhemet", "gates.toml"), "utf8");
    const where = g2Dirs();
    const p = await g2Project(where, {
      files: {
        ".sekhemet/gates.toml": gates,
        ".sekhemet/brief.md": "# Brief\n\n## Constraints\n- The stack.\n",
        ...files,
      },
      cards: [
        { ...cardZeroCard(stack), tier: "task", status: "ready" },
        { id: "card_one", tier: "story", title: "First test", status: "backlog", stepBudget: 1 },
      ],
      seed: async (store) => {
        const zero = (await store.listCards()).find((c) => c.id !== "card_one");
        if (!zero) throw new Error("no card zero");
        for (const s of ["in_progress", "verify", "review", "done"] as const) {
          await store.updateCardStatus(zero.id, s, "accepted", "human");
        }
        await store.updateCardStatus("card_one", "ready", "planned", "human", { override: true });
      },
    });
    const r = await cli(["queue", "--worker", SCRIPTED_MODEL], {
      cwd: p.repo,
      preload: p.preload,
      env: { ...p.env, ...scriptEnv(p.record) },
      timeoutMs: 120_000,
    });
    return { r, repo: p.repo };
  }

  it("DS-P2-1: a TypeScript project's checks are derived from npm init, tsc --init and Vitest's output, and the generator's versions recorded in the brief", async () => {
    const { r, repo } = await afterCardZero("typescript", {
      ".gitignore": "node_modules\n.sekhemet/*\n!.sekhemet/gates.toml\n!.sekhemet/brief.md\n",
      "package.json": JSON.stringify({
        name: "calc",
        version: "1.0.0",
        scripts: { test: "vitest run", typecheck: "tsc --noEmit" },
        devDependencies: { typescript: "^5.9.2", vitest: "^3.2.7" },
      }),
      "package-lock.json": JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { name: "calc" },
          "node_modules/typescript": { version: "5.9.2" },
          "node_modules/vitest": { version: "3.2.7" },
        },
      }),
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
    });
    expect(r.stdout + r.stderr).toMatch(/The setup issue is done: the project's checks are now/);
    const ids = loadGatesConfig(repo).gates.map((g) => g.id);
    expect(ids).toEqual(expect.arrayContaining(["typecheck", "unit"]));
    expect(ids).not.toContain("scaffold");
    expect(readFileSync(join(repo, ".sekhemet/brief.md"), "utf8")).toContain(
      "Generator: npm init, tsc --init and Vitest (TypeScript 5.9.2, Vitest 3.2.7)",
    );
  }, 120_000);

  it("DS-P2-2: a Python project's checks are derived from uv init's output", async () => {
    const { r, repo } = await afterCardZero("python", {
      ".gitignore": ".venv\n.sekhemet/*\n!.sekhemet/gates.toml\n!.sekhemet/brief.md\n",
      "pyproject.toml":
        '[project]\nname = "renamer"\nversion = "0.1.0"\nrequires-python = ">=3.12"\ndependencies = []\n\n[dependency-groups]\ndev = ["pytest>=8.3.4"]\n',
      ".python-version": "3.12\n",
      "uv.lock":
        'version = 1\nrequires-python = ">=3.12"\n\n[[package]]\nname = "pytest"\nversion = "8.3.4"\nsource = { registry = "https://pypi.org/simple" }\n',
      "main.py": 'def main():\n    print("Hello from renamer!")\n',
    });
    expect(r.stdout + r.stderr).toMatch(/The setup issue is done: the project's checks are now/);
    const unit = loadGatesConfig(repo).gates.find((g) => g.id === "unit");
    expect([unit?.command, ...(unit?.args ?? [])]).toEqual(["uv", "run", "pytest", "-q"]);
    expect(readFileSync(join(repo, ".sekhemet/brief.md"), "utf8")).toContain(
      "Generator: uv init (pytest 8.3.4, Python >=3.12)",
    );
    expect(readdirSync(repo)).not.toContain("node_modules");
  }, 120_000);
});
