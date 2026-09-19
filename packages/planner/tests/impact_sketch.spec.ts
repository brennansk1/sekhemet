import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { MockInferenceAdapter } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import {
  SpidrFeaturePlanner,
  analyzeImpact,
  inferDependenciesByImpact,
  persistPlan,
  sketchWithModel,
} from "../src/index.js";
import type { PlannedStory } from "../src/types.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "sek-impact-"));
  dirs.push(root);
  const w = (rel: string, text: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  w("src/money.ts", "export function money(n: number): number { return n; }\nexport type Cents = number;\n");
  w("src/ledger.ts", 'import { money } from "./money.js";\nexport class Ledger { add(n: number) { return money(n); } }\n');
  w("src/report.ts", 'import { Ledger } from "./ledger.js";\nexport const report = (l: Ledger) => String(l);\n');
  w("src/other.ts", "export const other = 1;\n");
  w("tests/money.spec.ts", 'import { money } from "../src/money.js";\nmoney(1);\n');
  return root;
}

describe("P24: impact analysis with the TypeScript compiler", () => {
  it("finds transitive importers, symbol referencers and the tests to run", async () => {
    const root = repo();
    const r = await analyzeImpact(root, ["src/money.ts"]);
    expect(r.engine).toBe("typescript");
    expect(r.importers).toEqual(["src/ledger.ts", "src/report.ts", "tests/money.spec.ts"]);
    expect(r.referencers.map((x) => x.file)).toEqual(["src/ledger.ts", "tests/money.spec.ts"]);
    expect(r.referencers[0]?.symbols).toEqual(["money"]);
    expect(r.blastRadius).not.toContain("src/other.ts");
    expect(r.tests).toEqual(["tests/money.spec.ts"]);
  });

  it("infers dependencies from impact, never both ways", async () => {
    const root = repo();
    const deps = await inferDependenciesByImpact(root, [
      { id: "a", scopeFiles: ["src/money.ts"] },
      { id: "b", scopeFiles: ["src/report.ts"] },
      { id: "c", scopeFiles: ["src/other.ts"] },
    ]);
    expect(deps).toEqual([{ cardId: "b", dependsOn: "a", via: ["src/report.ts"] }]);
  });
});

const story = (scope: string[]): PlannedStory =>
  ({
    card: {
      id: "card_s",
      tier: "story",
      title: "Round money to cents",
      status: "ready",
      scopeFiles: scope,
      stepBudget: 20,
      stepsUsed: 0,
      createdAt: "",
      updatedAt: "",
    },
    slice: "path",
    rationale: "Money must round.",
    keywords: ["money", "round"],
    acceptanceTests: [{ filePath: "tests/money.spec.ts", assertion: "money(1.005) is 1.01", initiallyFailing: true }],
    advances: [{ kind: "gate", ref: "unit" }],
    difficulty: { value: 5, factors: [] },
    routing: "edit_sketch",
    dependsOn: [],
    estimatedPackTokens: 2000,
    splitDepth: 0,
  }) as PlannedStory;

const reply = (text: string) => ({
  text,
  toolCalls: [],
  usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
});

describe("P7: model-written edit sketch, grounded in scope and outlines", () => {
  it("accepts a sketch that names scope files and real symbols, with planning reasoning", async () => {
    const root = repo();
    const model = new MockInferenceAdapter("planner", [
      reply(
        'Here: {"targetSymbols":[{"filePath":"src/money.ts","symbol":"money","change":"modify"}],"preconditions":["tests fail"],"invariants":["signature unchanged"],"diffSketch":"Round to two decimals with Math.round."}',
      ),
    ]);
    const r = await sketchWithModel(model, story(["src/money.ts"]), {
      repoRoot: root,
      blastRadius: ["src/ledger.ts"],
    });
    expect(r.source).toBe("model");
    expect(r.sketch.targetSymbols).toEqual([{ filePath: "src/money.ts", symbol: "money", change: "modify" }]);
    expect(r.sketch.blastRadius).toEqual(["src/ledger.ts", "src/money.ts"]);
    expect(model.callHistory[0]?.purpose).toBe("planning");
    expect(model.callHistory[0]?.reasoning).toBe("medium");
    expect(model.callHistory[0]?.prompt).toContain("export function money(n: number): number");
  });

  it("falls back to the template on an out-of-scope file or an invented symbol", async () => {
    const root = repo();
    const out = await sketchWithModel(
      new MockInferenceAdapter("p", [reply('{"targetSymbols":[{"filePath":"src/other.ts","symbol":"x","change":"add"}]}')]),
      story(["src/money.ts"]),
      { repoRoot: root },
    );
    expect(out).toMatchObject({ source: "template" });
    expect(out.rejected).toMatch(/outside the card's scope/);
    const invented = await sketchWithModel(
      new MockInferenceAdapter("p", [reply('{"targetSymbols":[{"filePath":"src/money.ts","symbol":"dollars","change":"modify"}]}')]),
      story(["src/money.ts"]),
      { repoRoot: root },
    );
    expect(invented.rejected).toMatch(/does not export/);
  });

  it("persistPlan uses the sketcher for edit_sketch cards and notes the impact", async () => {
    const db = new DatabaseSync(":memory:");
    initSchema(db);
    const log = new EventLog(db);
    const store = new CardStore(db, log);
    const spec = "Implement user authentication with JWT session cookies, password hashing, and rate limiting.";
    await store.createCard({ id: "epic_x", tier: "epic", title: spec, status: "in_progress" });
    const plan = await new SpidrFeaturePlanner().decomposeSpec({ parentId: "epic_x", parentTier: "epic", spec });
    for (const s of plan.stories) s.routing = "edit_sketch";
    const sketcher = new MockInferenceAdapter("planner", [reply("no json here")]);
    const res = await persistPlan({ log, store }, plan, { epicId: "epic_x", sketcher, repoRoot: repo() });
    expect(res.sketches.length).toBe(res.created.length);
    expect(res.sketches.every((s) => s.source === "template" && s.rejected)).toBe(true);
    expect(sketcher.callHistory.length).toBe(res.created.length);
    const dossier = JSON.stringify(await store.getDossier(res.created[0]?.id as string));
    expect(dossier).toContain("Edit sketch from the planner");
  });
});
