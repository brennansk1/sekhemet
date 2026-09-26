import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  interfaceFromTest,
  persistPlan,
  renderExampleTest,
  sketchWithModel,
} from "../src/index.js";

/**
 * Staged acceptance tests (planner-pm §2.1.5-8, PM-P1-15…19): each case
 * names the criterion it proves; a criterion with no case keeps the card in
 * Planning; examples are a table in the project's own framework and test
 * location; the card carries the interface the test imports. And the edit
 * sketch a model writes is persisted, never a literal patch (PM-P1-16).
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
  const db = new DatabaseSync(join(tmp("sek-staging-db-"), "events.db"));
  initSchema(db);
  const log = new EventLog(db);
  return { log, store: new CardStore(db, log) };
}

function repo(devDependencies: Record<string, string>): string {
  const root = tmp("sek-staging-repo-");
  const w = (rel: string, text: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  w("package.json", JSON.stringify({ name: "billing", devDependencies }));
  w("src/refund.ts", "export {};\n");
  w("tests/existing.spec.ts", "export {};\n");
  return root;
}

const reply = (text: string): InferenceResponse => ({
  text,
  toolCalls: [],
  usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
});

const TABLE =
  "Given a paid invoice of 1000 cents, refunding 400 leaves 600; given a paid invoice of 500 cents, refunding 500 leaves 0";
const REFUSAL =
  "Given a paid invoice of 1000 cents, refunding 1200 is rejected with the message 'refund exceeds invoice'";
const SIGNATURE = "refundInvoice(paidCents: number, refundCents: number): number";

const SLICES = JSON.stringify({
  slices: [
    {
      kind: "path",
      title: "Refund a paid invoice",
      keywords: ["refund", "invoice"],
      rationale: "The refund path first.",
      criteria: [
        {
          text: TABLE,
          examples: [
            { args: [1000, 400], expected: 600 },
            { args: [500, 500], expected: 0 },
          ],
        },
        { text: REFUSAL },
      ],
      interface: [{ symbol: "refundInvoice", file: "src/refund.ts", signature: SIGNATURE }],
    },
  ],
});

async function planned(root: string) {
  const l = diskLedger();
  const spec = "Refund a paid invoice.";
  await l.store.createCard({ id: "epic_r", tier: "epic", title: spec, status: "in_progress" });
  const adapter = new MockInferenceAdapter("planner", [reply(SLICES)], { exhaustion: "throw" });
  const plan = await new SpidrFeaturePlanner({
    adapter,
    codebaseMap: codebaseMapFromRepo(root),
  }).decomposeSpec({ parentId: "epic_r", parentTier: "epic", spec });
  const result = await persistPlan(l, plan, { epicId: "epic_r", repoRoot: root });
  const id = result.created[0]?.id as string;
  return { l, result, id, card: await l.store.getCard(id) };
}

describe("PM-P1-17: every staged case names the criterion it proves", () => {
  it("stages the test through the ledger with a criterion id per case", async () => {
    const root = repo({ vitest: "^3.0.0" });
    const { l, id, card } = await planned(root);
    expect(card?.criterionIds).toEqual([`${id}.c1`, `${id}.c2`]);
    const staged = l.store.stagedTests.staged(id);
    expect(staged.length).toBe(1);
    expect(staged[0]?.author).toBe("planner");
    expect(staged[0]?.cases?.length).toBe(2);
    for (const c of staged[0]?.cases ?? []) {
      expect(c.criterionId).toBe(`${id}.c1`);
      expect(c.name).toContain(`${id}.c1`);
    }
    const path = staged[0]?.path as string;
    expect(card?.acceptanceTests).toEqual([path]);
    const source = readFileSync(join(root, path), "utf8");
    expect(createHash("sha256").update(source).digest("hex")).toBe(staged[0]?.sha256);
    expect(source).toContain(`${id}.c1`);
  });
});

describe("PM-P1-18: a criterion with no staged case keeps the card in Planning", () => {
  it("holds the card and names the criterion", async () => {
    const root = repo({ vitest: "^3.0.0" });
    const { l, id, card, result } = await planned(root);
    expect(l.store.stagedTests.uncoveredCriteria(id)).toEqual([`${id}.c2`]);
    expect(card?.status).toBe("planning");
    expect(card?.blockedReason).toContain(`${id}.c2`);
    expect(result.held.find((h) => h.id === id)?.reasons.join(" ")).toContain(`${id}.c2`);
  });
});

describe("PM-P1-19: example values are a table of cases in the project's framework and location", () => {
  it("writes one row per example under the criterion, in the repository's test folder", async () => {
    const root = repo({ vitest: "^3.0.0" });
    const { l, id } = await planned(root);
    const path = l.store.stagedTests.staged(id)[0]?.path as string;
    expect(path.startsWith("tests/")).toBe(true);
    const source = readFileSync(join(root, path), "utf8");
    expect(source).toContain('from "vitest"');
    expect(source).toMatch(/it\.each<[^\n]*>\(\[/);
    expect(source).toContain("args: [1000, 400], expected: 600");
    expect(source).toContain("args: [500, 500], expected: 0");
    expect(source).toContain('from "../src/refund.js"');
  });

  it("uses Jest's globals in a Jest project", () => {
    const source = renderExampleTest({
      framework: "jest",
      testPath: "tests/refund.spec.ts",
      title: "Refund a paid invoice",
      symbol: { symbol: "refundInvoice", file: "src/refund.ts", signature: SIGNATURE },
      cases: [
        {
          criterionId: "c.c1",
          criterion: TABLE,
          rows: [{ args: [1000, 400], expected: 600 }],
        },
      ],
    }).source;
    expect(source).not.toContain("vitest");
    expect(source).toMatch(/it\.each<[^\n]*>\(\[/);
    expect(source).toContain("c.c1");
  });
});

describe("PM-P1-15: the card carries the interface its staged test imports", () => {
  it("reads symbol, file and the signature as the test uses it from the imports", () => {
    const source = [
      'import { describe, expect, it } from "vitest";',
      'import { hashEvent } from "../src/hasher.js";',
      'it("hashes", () => { expect(hashEvent({ payload, prev })).toHaveLength(64); });',
    ].join("\n");
    expect(interfaceFromTest(source, "tests/hasher.spec.ts")).toEqual([
      { symbol: "hashEvent", file: "src/hasher.ts", signature: "hashEvent({ payload, prev })" },
    ]);
  });

  it("records the staged test's imports on the card and in the Worker's notes", async () => {
    const root = repo({ vitest: "^3.0.0" });
    const { l, id, card } = await planned(root);
    expect(card?.interface).toEqual([
      { symbol: "refundInvoice", file: "src/refund.ts", signature: SIGNATURE },
    ]);
    const dossier = JSON.stringify(await l.store.getDossier(id));
    expect(dossier).toContain("refundInvoice");
    expect(dossier).toContain("src/refund.ts");
  });
});

describe("PM-P1-16: with a model, a difficulty 4-7 card gets a persisted edit sketch, never a patch", () => {
  const story = {
    card: {
      id: "story_x",
      tier: "story",
      title: "Refund a paid invoice",
      status: "ready",
      scopeFiles: ["src/refund.ts"],
      stepBudget: 20,
      stepsUsed: 0,
      createdAt: "",
      updatedAt: "",
    },
    slice: "path",
    rationale: "refund",
    keywords: ["refund"],
    acceptanceTests: [{ filePath: "tests/r.spec.ts", assertion: TABLE, initiallyFailing: true }],
    advances: [],
    difficulty: { value: 5, factors: [] },
    routing: "edit_sketch",
    dependsOn: [],
    estimatedPackTokens: 100,
    splitDepth: 0,
  } as never;

  it("refuses a reply whose outline is a literal patch", async () => {
    const r = await sketchWithModel(
      new MockInferenceAdapter("planner", [
        reply(
          JSON.stringify({
            targetSymbols: [{ filePath: "src/refund.ts", symbol: "refundInvoice", change: "add" }],
            diffSketch: "```diff\n-export {};\n+export function refundInvoice() {}\n```",
          }),
        ),
      ]),
      story,
    );
    expect(r.source).toBe("template");
    expect(r.rejected).toMatch(/patch/);
  });

  it("persists the model's sketch with targets, preconditions, invariants, outline and blast radius", async () => {
    const root = repo({ vitest: "^3.0.0" });
    const l = diskLedger();
    const spec = "Refund a paid invoice.";
    await l.store.createCard({ id: "epic_k", tier: "epic", title: spec, status: "in_progress" });
    const plan = await new SpidrFeaturePlanner({
      codebaseMap: codebaseMapFromRepo(root),
    }).decomposeSpec({ parentId: "epic_k", parentTier: "epic", spec });
    for (const s of plan.stories) s.routing = "edit_sketch";
    const sketcher = new MockInferenceAdapter("planner", [
      reply(
        JSON.stringify({
          targetSymbols: [{ filePath: "src/refund.ts", symbol: "refundInvoice", change: "add" }],
          preconditions: ["The invoice is paid."],
          invariants: ["The balance never goes below 0."],
          diffSketch: "Add refundInvoice, which subtracts the refund from the paid amount.",
        }),
      ),
    ]);
    const res = await persistPlan(l, plan, { epicId: "epic_k", sketcher, repoRoot: root });
    const withScope = res.sketches.find((s) => s.source === "model");
    expect(withScope, JSON.stringify(res.sketches)).toBeDefined();
    const dossier = JSON.stringify(await l.store.getDossier(withScope?.id as string));
    for (const part of ["add refundInvoice in src/refund.ts", "Preconditions", "Invariants"]) {
      expect(dossier).toContain(part);
    }
    expect(dossier).toContain("Blast radius");
    expect(dossier).not.toContain("```");
  });
});
