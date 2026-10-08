import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COMMANDS, routeFrontDoor } from "../src/cli_commands.js";
import { freePort } from "./support/cli_spawn.js";
import {
  type LedgerRow,
  cli,
  cliStart,
  g2Dirs,
  g2Env,
  ledgerRows,
  until,
} from "./support/g2_cli.js";
import { SCRIPTED_MODEL, recorded, scriptEnv, scriptedModel } from "./support/g2_model.js";

/**
 * DEFINITION_OF_DONE §6.7 and FINISH_LINE_PLAN V-42 (surface SUR-47; W10):
 * a fresh clone of a project reaches a first accepted issue by the README's
 * documented commands, run in the README's order through the built binary
 * (`apps/harness/dist/index.js`), with no file in either repository edited by
 * hand. Every command run is the README's, or one the product printed as the
 * next step. The Planning and Coding models the person downloads and verifies
 * (README: `models fetch`, then `doctor` names the verification) are a
 * scripted model at the HTTP boundary (`support/g2_model.ts`), recorded as
 * verified on this host and named with `--planner` and `--worker`; nothing is
 * downloaded and no model is loaded. A real git repository cloned from a
 * real origin, a real ledger, the project's own `node --test` as its check.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const README = join(ROOT, "README.md");
const QUALIFY = resolve(import.meta.dirname, "support/g2_qualify.mjs");

/**
 * The `sekhemet` command lines the README documents for a first run: the
 * Quickstart block, the spec it says to describe the work with, and the
 * commands table. Each is argv after `sekhemet`, placeholders kept.
 */
function readmeCommands(text: string): string[][] {
  const out: string[][] = [];
  const quick = text.slice(text.indexOf("## Quickstart"));
  const block = /```bash\n([\s\S]*?)```/.exec(quick)?.[1] ?? "";
  for (const line of block.split("\n")) {
    for (const part of line.replace(/\s#.*$/, "").split("&&")) {
      const words = part.trim().match(/"[^"]*"|\S+/g) ?? [];
      if (words[0] !== "sekhemet") continue;
      out.push(words.slice(1).map((w) => w.replace(/^"(.*)"$/, "$1")));
    }
  }
  const spec = /describe the work: `sekhemet "([^"]+)"`/.exec(quick)?.[1];
  if (spec) out.push([spec]);
  const table =
    /<!-- generated:readme-commands:start -->([\s\S]*?)<!-- generated:readme-commands:end -->/.exec(
      text,
    )?.[1];
  for (const m of (table ?? "").matchAll(/^\| `sekhemet ([a-z-]+)[^`]*` \|/gm))
    out.push([m[1] as string]);
  return out;
}

/** The README commands the front door does not know: a word that is no command, or a flag it refuses. */
function unknownToTheRegistry(commands: string[][]): string[] {
  const known = new Set<string>(COMMANDS);
  return commands
    .filter((argv) => {
      const route = routeFrontDoor(argv);
      if (route.kind === "unknown" || route.kind === "unknown-flag") return true;
      if (route.kind === "argv")
        return !known.has(argv[0] === "dev" ? (argv[1] ?? "") : (argv[0] ?? ""));
      return false;
    })
    .map((argv) => `sekhemet ${argv.join(" ")}`);
}

/** The project a person clones: a small Node module whose check is its own `node --test`. */
function originRepo(root: string): string {
  const origin = join(root, "origin");
  const files: Record<string, string> = {
    "package.json": `${JSON.stringify(
      {
        name: "reports",
        private: true,
        type: "module",
        scripts: { test: 'node --test "tests/**/*.spec.ts"' },
      },
      null,
      2,
    )}\n`,
    "README.md": "# Reports\n\nThe team's weekly reports.\n",
    "src/report.js": "export const rows = [];\n",
    "tests/report.spec.ts":
      'import assert from "node:assert/strict";\nimport { it } from "node:test";\nimport { rows } from "../src/report.js";\n\nit("starts with no rows", () => assert.deepEqual(rows, []));\n',
  };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(origin, rel)), { recursive: true });
    writeFileSync(join(origin, rel), text);
  }
  const git = (...a: string[]) => execFileSync("git", a, { cwd: origin, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git(
    "-c",
    "user.name=Origin",
    "-c",
    "user.email=origin@example.com",
    "commit",
    "-q",
    "-m",
    "reports",
  );
  return origin;
}

/** The Planning model's reply: one slice, traced to the spec's words, with a concrete example. */
const PLANNER_REPLY = JSON.stringify({
  slices: [
    {
      kind: "rule",
      title: "Count the rows of the reports page CSV export",
      keywords: ["csv", "export", "reports"],
      rationale: "the CSV export's size",
      criteria: [
        {
          text: "Given 2 report rows, csvRowCount returns 3, the header and two rows",
          examples: [{ args: [2], expected: 3 }],
        },
      ],
      interface: [
        { symbol: "csvRowCount", file: "src/csv.js", signature: "csvRowCount(number) → number" },
      ],
    },
  ],
  targetSymbols: [{ filePath: "src/csv.js", symbol: "csvRowCount", change: "add" }],
  preconditions: ["the row count is not negative"],
  invariants: ["an empty report exports only its header"],
  diffSketch: "Count the header and each row.",
});

/** The Coding model's turns: write the function, then finish. */
const WORKER = [
  [
    {
      name: "write_file",
      arguments: {
        path: "src/csv.js",
        content: "export const csvRowCount = (rows) => rows + 1;\n",
      },
    },
    { name: "finish_card", arguments: { summary: "csvRowCount counts the header and each row" } },
  ],
];

/** Every tracked file and its content, `.sekhemet/` (Sekhemet's own) aside. */
function trackedTree(repo: string, rev = "HEAD"): Record<string, string> {
  const out: Record<string, string> = {};
  const files = execFileSync("git", ["ls-tree", "-r", "--name-only", rev], {
    cwd: repo,
    encoding: "utf8",
  })
    .split("\n")
    .filter((f) => f && !f.startsWith(".sekhemet/"));
  for (const f of files)
    out[f] = execFileSync("git", ["show", `${rev}:${f}`], { cwd: repo, encoding: "utf8" });
  return out;
}

describe("the README's first run, from a fresh clone to an accepted issue (DoD §6.7, V-42, SUR-47)", () => {
  it("every command the README documents is one the front door knows; an unknown one is named", () => {
    const commands = readmeCommands(readFileSync(README, "utf8"));
    const words = commands.map((c) => c[0] ?? "(bare)");
    // The Quickstart's three, the spec, and the table's verbs.
    expect(words).toEqual(
      expect.arrayContaining([
        "doctor",
        "models",
        "add CSV export to the reports page",
        "accept",
        "review",
        "run",
      ]),
    );
    expect(commands).toContainEqual([]);
    expect(unknownToTheRegistry(commands)).toEqual([]);
    // A README naming a command the registry does not hold fails this test.
    const broken = readFileSync(README, "utf8").replace("sekhemet doctor ", "sekhemet doctr ");
    expect(unknownToTheRegistry(readmeCommands(broken))).toEqual(["sekhemet doctr"]);
  });

  it(
    "doctor, models fetch, the first run, a spec, approve, run, review and accept: the issue is merged to main and no file was edited by hand",
    { timeout: 400_000 },
    async () => {
      const commands = readmeCommands(readFileSync(README, "utf8"));
      const where = g2Dirs();
      const origin = originRepo(where.root);
      // `git clone … && cd sekhemet`: where the README runs doctor and models fetch.
      const checkout = join(where.root, "sekhemet");
      mkdirSync(checkout);
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: checkout });
      // `cd <your-project>`: a fresh clone of the person's project.
      const project = join(where.root, "reports");
      execFileSync("git", ["clone", "-q", origin, project]);
      const before = trackedTree(project);
      const models = join(where.home, ".sekhemet", "models");
      // A scripted model is reached over HTTP: the load guard would refuse it.
      const { SEKHEMET_MODEL_LOADS: _off, ...base } = g2Env(where.home);
      const { preload, record } = scriptedModel(where.home);
      const env = {
        ...base,
        GIT_AUTHOR_NAME: "Ada Lovelace",
        GIT_AUTHOR_EMAIL: "ada@example.com",
        GIT_COMMITTER_NAME: "Ada Lovelace",
        GIT_COMMITTER_EMAIL: "ada@example.com",
        ...scriptEnv(record, { other: PLANNER_REPLY, worker: WORKER }),
      };
      const sekhemet = (args: string[], cwd: string, timeoutMs = 180_000) =>
        cli(args, { cwd, env, preload, timeoutMs }).then((r) => ({
          ...r,
          out: r.stdout + r.stderr,
        }));
      const readme = (word: string) => commands.find((c) => c[0] === word);

      // 1. `sekhemet doctor`: what is owed, each with what to do.
      const doctor = readme("doctor") as string[];
      const d = await sekhemet(doctor, checkout);
      expect(d.out).toMatch(/=== Sekhemet Doctor Diagnostics ===/);
      for (const failed of d.out.split("\n").filter((l) => /^\s+✗/.test(l))) {
        const next = d.out.split("\n")[d.out.split("\n").indexOf(failed) + 1] ?? "";
        expect(next, failed).toMatch(/^\s+Do: /);
      }

      // 2. `sekhemet models fetch --recommended --folder …`: sizes and licences, then it asks.
      const fetchArgs = (readme("models") as string[]).map((a) =>
        a === "~/.sekhemet/models" ? models : a,
      );
      mkdirSync(models, { recursive: true });
      const f = await sekhemet(fetchArgs, checkout);
      expect(f.out).toMatch(/Coding\s+\S+: \S+\.gguf, [\d.]+ GB, licence \S+/);
      // No one to ask: nothing downloaded; a volume too small for the set is refused before the question.
      expect(f.out).toMatch(
        /Nothing was downloaded: no one was asked|The set needs [\d.]+ GB but the volume holding .* has [\d.]+ GB free; nothing was downloaded\./,
      );
      expect(readdirSync(models)).toEqual([]);

      // 3. `cd <your-project> && sekhemet`: with no terminal to confirm in, nothing is written and it says how.
      const bare = await sekhemet([], project, 60_000);
      expect(bare.out).toMatch(/Checks from package\.json: unit\./);
      expect(bare.out).toMatch(
        /No terminal to confirm in: nothing was written\. Run `sekhemet --yes` to set up here\./,
      );
      expect(existsSync(join(project, ".sekhemet", "config.toml"))).toBe(false);
      // The command it named: the first run, then Configuration (no model set up yet).
      const port = await freePort();
      const served = cliStart(["--yes", "--port", String(port)], { cwd: project, env, preload });
      try {
        await until(
          () =>
            new RegExp(
              `Sekhemet Configuration: http://127\\.0\\.0\\.1:${port}/#/configuration`,
            ).test(served.output()),
          60_000,
        );
      } finally {
        await served.stop();
      }
      const gates = readFileSync(join(project, ".sekhemet", "gates.toml"), "utf8");
      expect(gates).toMatch(
        /id = "unit"\nrung = "test"\nlayer = "functional"\ncommand = "npm"\nargs = \["run", "test"\]/,
      );

      // The person's verified models: the scripted model, verified on this host for Coding and Planning.
      execFileSync(process.execPath, [QUALIFY, SCRIPTED_MODEL, '[{},{"role":"planner"}]'], {
        env,
        encoding: "utf8",
      });
      const named = ["--planner", SCRIPTED_MODEL, "--worker", SCRIPTED_MODEL];

      // 4. `sekhemet "<spec>"`: planned; the issue waits on the person's approval of its criteria, and the command is printed.
      const spec = commands.find((c) => c.length === 1 && /\s/.test(c[0] ?? "")) as string[];
      const planned = await sekhemet([...spec, ...named], project);
      expect(planned.status, planned.out).toBe(0);
      expect(planned.out).toMatch(/Plan v1: 1 issue planned, 1 held in Planning\./);
      const approve =
        /Approve the criteria before any issue leaves Planning: sekhemet (approve \S+)/.exec(
          planned.out,
        )?.[1];
      expect(approve, planned.out).toBeDefined();
      const rows = (): LedgerRow[] => ledgerRows(project);
      const issue = rows().find((r) => r.type === "card/created" && r.payload.tier === "story")
        ?.cardId as string;
      expect(issue).toMatch(/^story_/);

      // 5. The printed command, as printed.
      const approved = await sekhemet((approve as string).split(" "), project);
      expect(approved.status, approved.out).toBe(0);
      expect(approved.out).toMatch(/Approved 1 issue .*; 1 left Planning\./);

      // 6. `sekhemet run`: the queue builds it in its worktree against its checks.
      const ran = await sekhemet(
        [...(readme("run") as string[]), "--worker", SCRIPTED_MODEL],
        project,
        300_000,
      );
      expect(ran.out).toContain(`=== ${issue} (attempt 1)`);
      expect(ran.out, ran.out).toMatch(/PASSED \(gate_passed\)/);
      expect(recorded(record).filter((r) => r.role === "worker").length).toBeGreaterThan(0);
      // The staged test reached the issue's worktree, and the last run of its check passed there.
      expect(ran.out).toMatch(/staged acceptance test: tests\/\S+\.spec\.ts/);
      const results = rows().filter((r) => r.type === "gate/result" && r.cardId === issue);
      const last = results.filter((r) => r.payload.attemptId === results.at(-1)?.payload.attemptId);
      // The project's own check passed on the change; advisory scans (osv offline) do not block.
      expect(last.find((r) => r.payload.gate === "unit")?.payload).toMatchObject({
        passed: true,
        exitCode: 0,
      });

      // 7. `sekhemet review`: the issue waiting on the person.
      const review = await sekhemet(readme("review") as string[], project);
      expect(review.out).toContain(issue);

      // 8. `sekhemet accept <issue>`: merged to main.
      const accepted = await sekhemet([...(readme("accept") as string[]), issue], project);
      expect(accepted.status, accepted.out).toBe(0);
      const after = trackedTree(project, "main");
      expect(after["src/csv.js"]).toBe("export const csvRowCount = (rows) => rows + 1;\n");
      // No file of the person's was edited, by hand or otherwise: what was there is unchanged.
      for (const [file, text] of Object.entries(before)) expect(after[file], file).toBe(text);
      // Every new file on main is the issue's: the Agent's code and the staged test.
      expect(
        Object.keys(after)
          .filter((f) => !(f in before))
          .sort(),
      ).toEqual(expect.arrayContaining(["src/csv.js"]));
      expect(
        rows().some(
          (r) =>
            r.type === "card/status_changed" && r.cardId === issue && r.payload.toStatus === "done",
        ),
      ).toBe(true);
    },
  );
});
