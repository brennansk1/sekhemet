import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type { CardStore } from "@sekhemet/kernel";
import { describe, expect, it } from "vitest";
import { ledgerRows } from "./support/g2_cli.js";
import { recorded } from "./support/g2_model.js";
import { type Evidence, latestEvidence } from "./support/g4_gate.js";
import { FINISH, queueProject, runQueue, write } from "./support/g4_queue.js";

/**
 * Test strength in the card's run (gates rules 6, 6a, 6b, 32, 32a; NEW-gates-6;
 * FINISH_LINE_PLAN C2d): `sekhemet queue` spawned as the built binary
 * (`apps/harness/dist/index.js`, through `support/g2_cli.ts`) over a real
 * repository whose `gates.toml` runs the real Vitest, with the card's
 * acceptance tests staged from `acceptance/` as the run stages them and a
 * Planner's `test/staged` record making them the card's own. The Worker is a
 * scripted model at the HTTP boundary (`support/g2_model.ts`); every
 * assertion is on what the binary printed, the requests it sent the Worker,
 * the evidence bundle and the ledger it wrote.
 */

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const VITEST = join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");
const TSC = join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");

const UNIT = `[[gate]]\nid = "unit"\nrung = "test"\ncommand = "node"\nargs = [${JSON.stringify(VITEST)}, "run"]\nparser = "vitest"\ntimeout_s = 120\n`;
const PROJECT = {
  "package.json": '{ "name": "s", "type": "module", "private": true }\n',
  "tsconfig.json":
    '{ "compilerOptions": { "strict": true, "noEmit": true, "module": "nodenext", "target": "es2022", "skipLibCheck": true }, "include": ["src"] }\n',
  "src/keep.ts": "export const keep = 1;\n",
};

/** A Planner's record of the staged file: the test is the card's own (gates rule 6a, lead ruling). */
const plannerStaged =
  (cardId: string, name: string, content: string) => async (store: CardStore) => {
    await store.recordEvent({
      type: "test/staged",
      cardId,
      actor: "planner",
      payload: {
        cardId,
        path: `tests/${name}`,
        sha256: createHash("sha256").update(content).digest("hex"),
        author: "planner",
      },
    });
  };

/** The card's worktree as git sees it, untracked files included. */
const status = (repo: string) =>
  execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: join(repo, ".sekhemet", "worktrees", "c1"),
    encoding: "utf8",
  });

const workerAsked = (record: string) => recorded(record).filter((r) => r.role === "worker").length;

describe("red for the right reason, before any step (GT-TQ-1, GT-TQ-2, GT-TQ-6)", () => {
  it("GT-TQ-1: a card whose own test fails at import, not at an assertion, stops with tests_not_red_for_reason naming the test, and the Worker is never asked", async () => {
    const TEST = `import { expect, it } from "vitest";
import { add } from "../src/math.js";
import { fixture } from "./fixtures/absent.js";
it("adds", () => { expect(add(fixture, 1)).toBe(2); });
`;
    const p = await queueProject({
      files: { ...PROJECT, "acceptance/a.spec.ts": TEST, ".sekhemet/gates.toml": UNIT },
      cards: [
        {
          id: "c1",
          tier: "story",
          title: "Add math",
          scopeFiles: ["src/math.ts"],
          stepBudget: 4,
          spec: "Add add().",
          acceptanceTests: ["a.spec.ts"],
        },
      ],
      seed: plannerStaged("c1", "a.spec.ts", TEST),
    });
    const r = await runQueue(p, [FINISH]);
    expect(r.stdout, r.stderr).toMatch(/\(tests_not_red_for_reason\)/);
    expect(r.stdout).toContain("tests/a.spec.ts");
    expect(workerAsked(p.record)).toBe(0);
    const e = latestEvidence(p.repo, "c1") as Evidence & {
      testStrength?: { redAtAssertion: { status: string } };
    };
    expect(e.stopReason).toBe("tests_not_red_for_reason");
    expect(e.testStrength?.redAtAssertion.status).toBe("not_red_for_reason");
  });

  it("GT-TQ-2: a card whose tests a trivial implementation passes stops with vacuous_tests naming the stand-in and the passing test, before any step", async () => {
    const TEST = `import { expect, it } from "vitest";
import { add } from "../src/math.js";
it("adds nothing to nothing", () => { expect(add(0, 0)).toBe(0); });
`;
    const p = await queueProject({
      files: { ...PROJECT, "acceptance/a.spec.ts": TEST, ".sekhemet/gates.toml": UNIT },
      cards: [
        {
          id: "c1",
          tier: "story",
          title: "Add math",
          scopeFiles: ["src/math.ts"],
          stepBudget: 4,
          spec: "Add add().",
          acceptanceTests: ["a.spec.ts"],
        },
      ],
      seed: plannerStaged("c1", "a.spec.ts", TEST),
    });
    const r = await runQueue(p, [FINISH]);
    expect(r.stdout, r.stderr).toMatch(/\(vacuous_tests\)/);
    expect(r.stdout).toContain("returns 0");
    expect(r.stdout).toContain("adds nothing to nothing");
    expect(workerAsked(p.record)).toBe(0);
    const e = latestEvidence(p.repo, "c1") as Evidence & {
      testStrength?: { stubKill: { status: string; standIn?: string; passing?: string[] } };
    };
    expect(e.testStrength?.stubKill).toMatchObject({ status: "survived", standIn: "returns 0" });
    // No stand-in is left behind: the worktree holds only the staged test.
    expect(status(p.repo)).toBe("A  tests/a.spec.ts\n");
  });

  it("GT-TQ-6: an acceptance test asserting two constants is refused by the smell lint at the default profile, before any step", async () => {
    const TEST = `import { expect, it } from "vitest";
import { add } from "../src/math.js";
it("adds", () => { expect(1).toBe(1); void add; });
`;
    const p = await queueProject({
      files: { ...PROJECT, "acceptance/a.spec.ts": TEST, ".sekhemet/gates.toml": UNIT },
      cards: [
        {
          id: "c1",
          tier: "story",
          title: "Add math",
          scopeFiles: ["src/math.ts"],
          stepBudget: 4,
          spec: "Add add().",
          acceptanceTests: ["a.spec.ts"],
        },
      ],
      seed: plannerStaged("c1", "a.spec.ts", TEST),
    });
    const r = await runQueue(p, [FINISH]);
    expect(r.stdout, r.stderr).toMatch(/\(vacuous_tests\)/);
    expect(r.stdout).toMatch(/cannot fail as written/);
    expect(workerAsked(p.record)).toBe(0);
    const e = latestEvidence(p.repo, "c1") as Evidence & {
      testStrength?: { smells: { file: string; smell: string }[]; profileNote: string };
    };
    expect(e.testStrength?.smells.map((s) => s.file)).toEqual(["tests/a.spec.ts"]);
    expect(e.testStrength?.profileNote).toBe("depth profile: internal tool (default)");
  });
});

describe("a card that is red at an assertion and kills every stand-in (GT-TQ-3, -4, -5, -6, -9, -12)", () => {
  it("GT-TQ-3, GT-TQ-4, GT-TQ-5, GT-TQ-6, GT-TQ-9, GT-TQ-12: the run records the strength at the default profile, scores the mutants twice with stillborn and equivalent ones excluded, and routes a survivor to a person as passing, strength unmet", async () => {
    const TEST = `import { expect, it } from "vitest";
import { big } from "../src/m.js";
it("big for eleven", () => { expect(big(11)).toBe(true); });
it("not big for three", () => { expect(big(3)).toBe(false); });
`;
    const IMPL = [
      "type Flag = true;",
      "export const flag: Flag = true;",
      "export const join2 = (a: string, b: string): string => a + b;",
      "export function big(n: number): boolean {",
      "  return n > 10;",
      "}",
      "",
    ].join("\n");
    const p = await queueProject({
      files: {
        ...PROJECT,
        "acceptance/m.spec.ts": TEST,
        ".sekhemet/gates.toml": `[project]\nmutation = true\nmutation_blocking = true\n\n[[gate]]\nid = "types"\nrung = "typecheck"\ncommand = "node"\nargs = [${JSON.stringify(TSC)}, "-p", "."]\nparser = "tsc"\ntimeout_s = 120\n\n${UNIT}`,
      },
      cards: [
        {
          id: "c1",
          tier: "story",
          title: "Add big",
          scopeFiles: ["src/m.ts"],
          stepBudget: 4,
          spec: "Export big, flag and join2 from src/m.ts.",
          acceptanceTests: ["m.spec.ts"],
        },
      ],
      seed: plannerStaged("c1", "m.spec.ts", TEST),
    });
    const r = await runQueue(p, [[...write("src/m.ts", IMPL), ...FINISH]]);
    expect(r.stdout, r.stderr).toMatch(/PASSED \(gate_passed\)/);
    const e = latestEvidence(p.repo, "c1") as Evidence & {
      testStrength?: {
        profileNote: string;
        redAtAssertion: { status: string; requireAssertions: boolean };
        stubKill: { status: string };
      };
    };
    // Rule 32a's record, at the internal-tool default (GT-TQ-9, GT-TQ-12).
    expect(e.testStrength?.profileNote).toBe("depth profile: internal tool (default)");
    expect(e.testStrength?.redAtAssertion.status).toBe("red");
    // GT-TQ-6: the acceptance run asked Vitest to require an assertion in every test.
    expect(e.testStrength?.redAtAssertion.requireAssertions).toBe(true);
    expect(e.testStrength?.stubKill.status).toBe("killed");
    const m = e.rungResults.find((o) => o.gate === "mutation")?.mutation as {
      score: number;
      killed: number;
      total: number;
      stillborn: number;
      equivalent: number;
      strengthUnmet?: boolean;
      acceptance: { score: number | null; killed: number; total: number; reason?: string };
    };
    // GT-TQ-4: the `type Flag` mutant is erased by the transpiler; `flag: Flag = false` and
    // string subtraction fail the typecheck. Neither counts in either score.
    expect(m.equivalent).toBeGreaterThanOrEqual(1);
    expect(m.stillborn).toBeGreaterThanOrEqual(2);
    // GT-TQ-3: two scores over the same live mutants.
    expect(m.total).toBeGreaterThan(0);
    expect(m.acceptance.reason).toBeUndefined();
    expect(m.acceptance.total).toBe(m.total);
    expect(m.score).toBe(m.killed / m.total);
    // GT-TQ-5: `n >= 10` survives the tests (no test at ten): a gap for a person, never
    // the Worker's failure; with mutation_blocking the requirement is passing, strength unmet.
    expect(m.killed).toBeLessThan(m.total);
    expect(m.strengthUnmet).toBe(true);
    expect(e.passed).toBe(true);
    expect(e.failures).toEqual([]);
    expect(e.advisories.join("\n")).toMatch(
      /mutation survived: src\/m\.ts:5 .*a test gap for a person, not the Worker's failure/,
    );
    // The Worker was asked once: no survivor was put to it as a failure.
    expect(workerAsked(p.record)).toBe(1);
  });
});

describe("the card's `change` selects the red/green rule (GT-TQ-8, GT-TQ-10, GT-TQ-11)", () => {
  it("GT-TQ-8: a refactor card that changes its scope's exported surface fails verification naming the names; declaring the surface change passes", async () => {
    const files = {
      ...PROJECT,
      "src/lib.ts": "export const a = 1;\nexport const b = 2;\n",
      "src/main.ts": 'import { a, b } from "./lib.js";\nconsole.log(a, b);\n',
      ".sekhemet/gates.toml": `[[gate]]\nid = "unit"\nrung = "test"\ncommand = "sh"\nargs = ["-c", "exit 0"]\nparser = "generic"\n`,
    };
    const turns = [
      [{ name: "read_file", arguments: { path: "src/lib.ts" } }],
      [
        ...write("src/lib.ts", "export const a = 1;\nconst b = 2;\nexport const c = b;\n"),
        ...FINISH,
      ],
      FINISH,
      FINISH,
    ];
    const base = {
      tier: "story" as const,
      title: "Tidy lib",
      scopeFiles: ["src/lib.ts"],
      stepBudget: 4,
      spec: "Tidy src/lib.ts; export c.",
      change: "refactor" as const,
    };
    const p = await queueProject({ files, cards: [{ id: "c1", ...base }] });
    const r = await runQueue(p, turns);
    expect(r.stdout, r.stderr).not.toMatch(/PASSED \(gate_passed\)/);
    const e = latestEvidence(p.repo, "c1") as Evidence;
    const surface = e.failures.find((f) => f.gate === "refactor-surface");
    expect(surface?.errorExcerpt).toContain("src/lib.ts: removed b; added c");

    const q = await queueProject({
      files,
      cards: [{ id: "c1", ...base, gateChecks: { surfaceChange: true } }],
    });
    const ok = await runQueue(q, turns);
    expect(ok.stdout, ok.stderr).toMatch(/PASSED \(gate_passed\)/);
    expect(
      latestEvidence(q.repo, "c1")?.rungResults.find((o) => o.gate === "refactor-surface")?.passed,
    ).toBe(true);
  });

  it("GT-TQ-10: a characterize card's tests, green on the base, are refused when a stand-in of the code they cover passes them, naming it, before any step", async () => {
    const TEST = `import { expect, it } from "vitest";
import { double } from "../src/calc.js";
it("doubles zero", () => { expect(double(0)).toBe(0); });
`;
    const p = await queueProject({
      files: {
        ...PROJECT,
        "src/calc.ts": "export function double(n: number): number {\n  return n * 2;\n}\n",
        "acceptance/c.spec.ts": TEST,
        ".sekhemet/gates.toml": UNIT,
      },
      cards: [
        {
          id: "c1",
          tier: "story",
          title: "Pin double",
          scopeFiles: ["src/calc.ts"],
          stepBudget: 4,
          spec: "Characterize double.",
          acceptanceTests: ["c.spec.ts"],
          change: "characterize",
        },
      ],
      seed: plannerStaged("c1", "c.spec.ts", TEST),
    });
    const r = await runQueue(p, [FINISH]);
    expect(r.stdout, r.stderr).toMatch(/\(vacuous_tests\)/);
    expect(r.stdout).toContain("returns 0");
    expect(r.stdout).toContain("doubles zero");
    expect(workerAsked(p.record)).toBe(0);
    // The covered code is as it was: the stand-ins were put back.
    expect(status(p.repo)).toBe("A  tests/c.spec.ts\n");
  });

  it("GT-TQ-11: an upgrade card records the base's passing tests to keep, fails verification naming a kept test that breaks, and refuses to start with none", async () => {
    const files = {
      ...PROJECT,
      "src/greet.ts": "export function greet(n: string): string {\n  return `hi ${n}`;\n}\n",
      "tests/greet.spec.ts": `import { expect, it } from "vitest";
import { greet } from "../src/greet.js";
it("greets", () => { expect(greet("a")).toBe("hi a"); });
it("greets twice", () => { expect(greet(greet("b"))).toBe("hi hi b"); });
`,
      ".sekhemet/gates.toml": UNIT,
    };
    const up = {
      tier: "story" as const,
      title: "Upgrade greet",
      scopeFiles: ["src/greet.ts"],
      stepBudget: 3,
      spec: "Upgrade greet.",
      change: "upgrade" as const,
    };
    const p = await queueProject({ files, cards: [{ id: "c1", ...up }] });
    const r = await runQueue(p, [
      [{ name: "read_file", arguments: { path: "src/greet.ts" } }],
      [
        ...write(
          "src/greet.ts",
          "export function greet(n: string): string {\n  return `hello ${n}`;\n}\n",
        ),
        ...FINISH,
      ],
      FINISH,
    ]);
    expect(r.stdout, r.stderr).not.toMatch(/PASSED \(gate_passed\)/);
    const updated = ledgerRows(p.repo).filter(
      (e) => e.type === "card/updated" && e.cardId === "c1",
    );
    expect(JSON.stringify(updated.map((e) => e.payload))).toContain(
      "tests/greet.spec.ts > greets twice",
    );
    const kept = (latestEvidence(p.repo, "c1") as Evidence).failures.filter(
      (f) => f.gate === "upgrade-tests",
    );
    expect(kept.map((f) => f.errorExcerpt)).toContain(
      "tests/greet.spec.ts > greets: kept by the upgrade, fails after it",
    );

    // No test passes on the base: nothing to keep, so the card does not start.
    const { "tests/greet.spec.ts": _t, ...bare } = files;
    const q = await queueProject({ files: bare, cards: [{ id: "c1", ...up }] });
    const none = await runQueue(q, [FINISH]);
    expect(none.stdout, none.stderr).toMatch(/\(base_not_green\)/);
    expect(none.stdout).toMatch(/no test to keep/);
    expect(workerAsked(q.record)).toBe(0);
  });
});
