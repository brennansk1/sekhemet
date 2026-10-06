import { describe, expect, it } from "vitest";
import { cli, g2Dirs, ledgerRows } from "./support/g2_cli.js";
import {
  type Recorded,
  SCRIPTED_MODEL,
  type Turn,
  recorded,
  scriptEnv,
} from "./support/g2_model.js";
import { g2Project } from "./support/g2_project.js";

/**
 * The Researcher asked before a repair plan (design-stage §2.7.4,
 * NEW-design-stage-5: DS-N5-1 to DS-N5-3; context CX-N3-5; FINISH_LINE_PLAN C2d): `sekhemet
 * queue --worker --manager --researcher`, spawned as the built binary over a
 * real repository and ledger, each role the recording scripted model at the
 * HTTP boundary. The card struggles with one failure through an edit, fixes
 * it, then fails on another: its repair batch asks the Researcher first.
 *
 * The binary under test is `apps/harness/dist/index.js`, spawned by
 * `support/g2_cli.ts`.
 */

const ADDS = "tests/total.test.ts > adds: AssertionError: expected 3 to equal 4";
const ROUNDS = "tests/total.test.ts > rounds: AssertionError: expected 4.1 to equal 4";
/** The first two runs fail on ADDS, every later one on ROUNDS; the count lives in the worktree. */
const GATE = [
  "-e",
  `const fs = require('fs'); fs.mkdirSync('.sekhemet', { recursive: true }); const f = '.sekhemet/g2-gate-runs'; const n = fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : 0; fs.writeFileSync(f, String(n + 1)); console.log(n < 2 ? ${JSON.stringify(ADDS)} : ${JSON.stringify(ROUNDS)}); process.exit(1);`,
];
const ANSWER = `ANSWER-START ${"total in src/total.ts subtracts from a + b [1]; it must return a + b exactly, with no rounding [1]. ".repeat(15)}ANSWER-END`;

const text = (r: Recorded) => r.body.messages.map((m) => m.content).join("\n");

describe("sekhemet queue: research before the repair plan", () => {
  it("DS-N5-1, DS-N5-2, DS-N5-3, CX-N3-5: the Researcher gets the card, its criteria, scope, typed failure and detected stack; its cited answer is stored whole on the card and given to the plan's author, whose plan the retry reads before its scope", async () => {
    const where = g2Dirs();
    const p = await g2Project(where, {
      files: {
        "src/total.ts": "export const total = (a: number, b: number) => a + b - 1;\n",
        "package.json": JSON.stringify({ name: "app", devDependencies: { vitest: "3.2.7" } }),
      },
      gateArgs: GATE,
      cards: [
        {
          id: "c1",
          tier: "story",
          title: "Fix total",
          scopeFiles: ["src/total.ts"],
          stepBudget: 4,
          spec: "total(1, 3) returns 4",
          acceptanceCriteria: ["total(1, 3) is 4"],
        },
      ],
      qualifyAs: [{}, { role: "planner" }, { role: "researcher" }],
    });
    const write = (n: number): Turn => [
      {
        name: "write_file",
        arguments: {
          path: "src/total.ts",
          content: `export const total = (a: number, b: number) => a + b - ${n};\n`,
        },
      },
      { name: "finish_card" },
    ];
    const r = await cli(
      [
        "queue",
        "--worker",
        SCRIPTED_MODEL,
        "--manager",
        SCRIPTED_MODEL,
        "--researcher",
        SCRIPTED_MODEL,
      ],
      {
        cwd: p.repo,
        preload: p.preload,
        env: {
          ...p.env,
          ...scriptEnv(p.record, {
            worker: [write(2), write(3), write(4)],
            researcher: [[{ name: "git_history", arguments: { query: "seed" } }], ANSWER],
            other: "PLAN: return a + b without subtracting.",
          }),
        },
        timeoutMs: 180_000,
      },
    );
    expect(r.stdout, r.stderr).toMatch(/researched first: 1 source, on the issue's dossier/);
    const sent = recorded(p.record);
    const research = sent.find((x) => x.role === "researcher");
    if (!research) throw new Error("the Researcher was never asked");
    // DS-N5-1: the card's spec, criteria, scope files, the failing gate's typed
    // failure and the stack its manifests say — not a hard-coded language.
    const question = text(research);
    expect(question).toMatch(
      /A coding model working on a JavaScript \(Node\.js, \w+\) project failed this card/,
    );
    expect(question).toMatch(/CARD\nFix total\n\ntotal\(1, 3\) returns 4/);
    expect(question).toMatch(/ACCEPTANCE CRITERIA\n1\. total\(1, 3\) is 4/);
    expect(question).toMatch(/SCOPE FILES\nsrc\/total\.ts/);
    expect(question).toMatch(
      /FAILING GATE\ngate: unit \(functional\)\nlocation: tests\/total\.test\.ts/,
    );
    expect(question).toContain(`WHAT IT STRUGGLED WITH\n${ADDS}`);
    expect(question).not.toMatch(/TypeScript project/);

    // DS-N5-3: the answer recorded whole on the card's dossier.
    const entry = ledgerRows(p.repo).find((x) => x.type === "card/research" && x.cardId === "c1");
    const stored = String(entry?.payload.text ?? "");
    expect(stored).toContain(ANSWER);

    // DS-N5-2: researched before the plan, and the plan's author was given it.
    const order = sent.map((x) => x.role);
    const plan = sent.find((x) => /Write the repair plan now\./.test(text(x)));
    if (!plan) throw new Error("no repair plan was asked for");
    expect(order.indexOf("researcher")).toBeLessThan(sent.indexOf(plan));
    expect(text(plan)).toContain("total in src/total.ts subtracts from a + b");
    expect(ledgerRows(p.repo).some((x) => x.type === "card/repair_plan" && x.cardId === "c1")).toBe(
      true,
    );

    // CX-N3-5: the retry's prompt carries the re-plan's plan before the scope file.
    const retry = sent.slice(sent.indexOf(plan)).find((x) => x.role === "worker");
    if (!retry) throw new Error("the retry never reached the Worker");
    const prompt = retry.body.messages.find((m) => m.role === "user")?.content ?? "";
    const scope = prompt.indexOf("=== SCOPE FILE: src/total.ts");
    expect(scope).toBeGreaterThan(0);
    const planAt = prompt.indexOf("PLAN: return a + b without subtracting.");
    expect(planAt).toBeGreaterThanOrEqual(0);
    expect(planAt).toBeLessThan(scope);
  }, 240_000);
});
