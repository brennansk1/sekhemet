import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { type InferenceResponse, MockInferenceAdapter } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import {
  type PlannerLedger,
  SpidrFeaturePlanner,
  codebaseMapFromRepo,
  localiseFix,
  ochiai,
  persistPlan,
  rankSuspiciousLines,
  runWithCoverage,
} from "../src/index.js";

/**
 * Fix localisation (planner-pm §2.16.5, PM-N6-5): for a `fix` card with a
 * reproduction test, candidate lines are ranked by spectrum-based
 * suspiciousness (Ochiai) from the failing and passing tests' V8 coverage
 * (`NODE_V8_COVERAGE`, no dependency), and the ranking is recorded with the
 * scope. Real processes, real coverage.
 */
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function diskLedger(): PlannerLedger {
  const db = new DatabaseSync(join(tmp("sek-sbfl-db-"), "events.db"));
  initSchema(db);
  const log = new EventLog(db);
  return { log, store: new CardStore(db, log) };
}

/** A priced module with a bug on line 3, one failing and two passing tests. */
function shop(): string {
  const root = tmp("sek-sbfl-repo-");
  const w = (rel: string, text: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  w(
    "src/price.mjs",
    [
      "export function price(n) {",
      "  if (n > 10) {",
      "    return n * 2 - 1;",
      "  }",
      "  return n * 2;",
      "}",
      "",
    ].join("\n"),
  );
  const test = (name: string, n: number, expected: number) =>
    [
      'import assert from "node:assert/strict";',
      'import { test } from "node:test";',
      'import { price } from "../src/price.mjs";',
      `test("${name}", () => {`,
      `  assert.equal(price(${n}), ${expected});`,
      "});",
      "",
    ].join("\n");
  w("tests/big.test.mjs", test("big order doubles", 11, 22));
  w("tests/small.test.mjs", test("small order doubles", 3, 6));
  w("tests/edge.test.mjs", test("ten doubles", 10, 20));
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

describe("PM-N6-5: candidate lines ranked by spectrum-based suspiciousness", () => {
  it("Ochiai: covered only by failing tests is most suspicious; never by a failing test is not", () => {
    expect(ochiai(1, 0, 1)).toBe(1);
    expect(ochiai(1, 1, 1)).toBeCloseTo(Math.SQRT1_2);
    expect(ochiai(0, 3, 1)).toBe(0);
  });

  it("reads each test's executed lines from V8 coverage of a real run", async () => {
    const root = shop();
    const failing = await runWithCoverage(root, ["node", "--test", "tests/big.test.mjs"]);
    expect(failing.passed).toBe(false);
    expect([...(failing.lines.get("src/price.mjs") ?? [])].sort()).toEqual([1, 2, 3]);
    const passing = await runWithCoverage(root, ["node", "--test", "tests/small.test.mjs"]);
    expect(passing.passed).toBe(true);
    expect(passing.lines.get("src/price.mjs")?.has(3)).toBe(false);
    expect(passing.lines.get("src/price.mjs")?.has(5)).toBe(true);
    // Test files are not candidates.
    expect([...failing.lines.keys()].some((f) => f.startsWith("tests/"))).toBe(false);
  });

  it("BLOCKER, fixed: runs confined — a staged test cannot write outside the card's root", async () => {
    const root = shop();
    const outside = tmp("sek-sbfl-outside-");
    const marker = join(outside, "escaped.txt");
    writeFileSync(
      join(root, "tests/escape.test.mjs"),
      [
        'import { writeFileSync } from "node:fs";',
        'import { test } from "node:test";',
        `test("tries to write outside its root", () => {`,
        `  try { writeFileSync(${JSON.stringify(marker)}, "escaped"); } catch {}`,
        "});",
        "",
      ].join("\n"),
    );
    await runWithCoverage(root, ["node", "--test", "tests/escape.test.mjs"]);
    expect(existsSync(marker)).toBe(false);
  });

  it("ranks the faulty line first and records the ranking with the card's scope", async () => {
    const root = shop();
    const l = diskLedger();
    await l.store.createCard({
      id: "fix_price",
      tier: "story",
      title: "Big orders double",
      status: "planning",
      scopeFiles: ["src/price.mjs"],
      change: "fix",
    });
    const ranking = await localiseFix(l, {
      cardId: "fix_price",
      root,
      failing: [["node", "--test", "tests/big.test.mjs"]],
      passing: [
        ["node", "--test", "tests/small.test.mjs"],
        ["node", "--test", "tests/edge.test.mjs"],
      ],
    });
    expect(ranking[0]).toMatchObject({ file: "src/price.mjs", line: 3, score: 1 });
    expect(ranking.find((r) => r.line === 5)?.score ?? 0).toBe(0);

    const [event] = await l.log.getEventsByTypes(["scope/localised"]);
    expect(event?.cardId).toBe("fix_price");
    expect(event?.payload).toMatchObject({
      cardId: "fix_price",
      method: "ochiai",
      failing: 1,
      passing: 2,
      scopeFiles: ["src/price.mjs"],
    });
    expect((event?.payload as { lines: unknown[] }).lines[0]).toEqual({
      file: "src/price.mjs",
      line: 3,
      score: 1,
    });
    // The Worker sees it with the scope: a note in the card's dossier.
    const notes = await l.store.getDossier("fix_price");
    expect(notes.notes.map((n) => n.text).join("\n")).toContain("src/price.mjs:3");
  });

  it("ranks nothing without a failing run", () => {
    expect(
      rankSuspiciousLines([{ passed: true, lines: new Map([["a.ts", new Set([1])]]) }]),
    ).toEqual([]);
  });
});

describe("PM-N6-5 at persist: a fix card's scope comes with its ranking", () => {
  it("runs the staged reproduction and the base tests with coverage and records the ranking", async () => {
    const root = shop();
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "shop", scripts: { test: "node --test tests/" } }),
    );
    // The base is green: the only failing run is the staged reproduction.
    rmSync(join(root, "tests/big.test.mjs"));
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base"],
      {
        cwd: root,
      },
    );
    const l = diskLedger();
    const spec = "Fix the price of big orders: a big order of 11 costs 22.";
    await l.store.createCard({ id: "epic_p", tier: "epic", title: spec, status: "in_progress" });
    const reply = (text: string): InferenceResponse => ({
      text,
      toolCalls: [],
      usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
    });
    const adapter = new MockInferenceAdapter(
      "planner",
      [
        reply(
          JSON.stringify({
            slices: [
              {
                kind: "path",
                title: "Big order price",
                keywords: ["price", "order"],
                rationale: "the defect",
                criteria: [
                  {
                    text: "Given a big order of 11 items, pricing the order returns 22",
                    examples: [{ args: [11], expected: 22 }],
                  },
                ],
                interface: [
                  { symbol: "price", file: "src/price.mjs", signature: "price(n: number): number" },
                ],
              },
            ],
          }),
        ),
      ],
      { exhaustion: "throw" },
    );
    const plan = await new SpidrFeaturePlanner({
      adapter,
      codebaseMap: codebaseMapFromRepo(root),
    }).decomposeSpec({ parentId: "epic_p", parentTier: "epic", spec });
    const result = await persistPlan(l, plan, { epicId: "epic_p", repoRoot: root });
    const id = result.created[0]?.id as string;
    expect((await l.store.getCard(id))?.change).toBe("fix");

    const [event] = await l.log.getEventsByTypes(["scope/localised"]);
    expect(event?.cardId).toBe(id);
    const payload = event?.payload as {
      failing: number;
      passing: number;
      lines: { file: string; line: number }[];
    };
    expect(payload.failing).toBe(1);
    expect(payload.passing).toBe(2);
    expect(payload.lines[0]).toMatchObject({ file: "src/price.mjs", line: 3 });
  });
});
