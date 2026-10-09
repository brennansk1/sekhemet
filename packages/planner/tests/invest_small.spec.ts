import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { type InferenceResponse, MockInferenceAdapter } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import * as planner from "../src/index.js";
import {
  DEFAULT_TIER_BUDGET,
  type PlannedStory,
  type PlannerLedger,
  SpidrFeaturePlanner,
  approvePlan,
  codebaseMapFromRepo,
  containsLineByLineDictation,
  persistPlan,
  validateInvest,
  workerPromptBudget,
  zone3Cap,
  zone3Fit,
} from "../src/index.js";

/**
 * INVEST *Small* is Zone 3's fit at the resolved Worker's prompt budget
 * (planner-pm §2.4, DEC-27; PM-12, PM-13, PM-14): 0.50 × (W − 2,400), which
 * is 3,792 tokens on the reference Worker, one computation shared with the
 * `ready` entry condition.
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
  const db = new DatabaseSync(join(tmp("sek-small-db-"), "events.db"));
  initSchema(db);
  const log = new EventLog(db);
  return { log, store: new CardStore(db, log) };
}

function story(id: string, packTokens: number, steps = 20): PlannedStory {
  return {
    card: {
      id,
      tier: "story",
      title: id,
      status: "ready",
      scopeFiles: [`src/${id}.ts`],
      stepBudget: steps,
      stepsUsed: 0,
      createdAt: "",
      updatedAt: "",
    },
    slice: "path",
    rationale: "r",
    keywords: [id],
    acceptanceTests: [
      { filePath: `tests/${id}.spec.ts`, assertion: "given 1, returns 2", initiallyFailing: true },
    ],
    advances: [{ kind: "gate", ref: "unit" }],
    difficulty: { value: 3, factors: [] },
    routing: "direct",
    dependsOn: [],
    estimatedPackTokens: packTokens,
    splitDepth: 0,
  };
}

const small = (stories: PlannedStory[], workerWindowTokens?: number) =>
  validateInvest(stories, {
    tierBudget: {
      ...DEFAULT_TIER_BUDGET,
      ...(workerWindowTokens ? { workerWindowTokens } : {}),
    },
  }).checks.find((c) => c.check === "small");

describe("PM-12: the reference Worker's Small cap is 3,792 tokens and 40 steps", () => {
  it("computes W = 9,984 and Zone 3's cap from the reference window", () => {
    expect(workerPromptBudget(16_384)).toBe(9_984);
    expect(zone3Cap(9_984)).toBe(3_792);
  });

  it("fails a card over 3,792 tokens or 40 steps and passes one at 3,792", () => {
    expect(small([story("at_cap", 3_792)])?.passed).toBe(true);
    expect(small([story("over_cap", 3_793)])?.offendingStoryIds).toEqual(["over_cap"]);
    expect(small([story("long", 100, 41)])?.offendingStoryIds).toEqual(["long"]);
  });
});

describe("PM-13: the cap follows the resolved Worker's window, with no fixed default or fraction", () => {
  it("is 0.50 × (W − 2,400) at a larger window", () => {
    const w = workerPromptBudget(32_768);
    expect(w).toBe(32_768 - 4_096 - 2_048 - 256);
    expect(zone3Cap(w)).toBe(Math.floor(0.5 * (w - 2_400)));
    expect(small([story("fits_large", 11_000)], 32_768)?.passed).toBe(true);
    expect(small([story("fits_large", 11_000)])?.passed).toBe(false);
  });

  it("retires the 25% fraction", () => {
    expect("INVEST_CONTEXT_FRACTION" in planner).toBe(false);
  });
});

describe("PM-14: the planner's Small and the ready entry check are one computation", () => {
  function repo(): string {
    const root = tmp("sek-small-repo-");
    const w = (rel: string, text: string) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    };
    w("package.json", JSON.stringify({ devDependencies: { vitest: "^3.0.0" } }));
    w("src/refund.ts", `export const refundRates = [${"1, ".repeat(400)}1];\n`);
    w("src/huge_report.ts", `export const rows = [${"12345, ".repeat(3_000)}1];\n`);
    w("tests/existing.spec.ts", "export {};\n");
    return root;
  }

  it("a card the planner made Ready passes the ready entry check at the same W", async () => {
    const root = repo();
    const l = diskLedger();
    const spec = "Refund a paid invoice.";
    await l.store.createCard({ id: "epic_z", tier: "epic", title: spec, status: "in_progress" });
    const slices = {
      slices: [
        {
          kind: "path",
          title: "Refund a paid invoice",
          keywords: ["refund", "invoice"],
          rationale: "The refund path first.",
          criteria: [
            {
              text: "Given a paid invoice of 1000 cents, refunding 400 leaves 600",
              examples: [{ args: [1000, 400], expected: 600 }],
            },
          ],
          interface: [
            { symbol: "refundInvoice", file: "src/refund.ts", signature: "refundInvoice(a, b)" },
          ],
        },
      ],
    };
    const adapter = new MockInferenceAdapter("planner", [
      {
        text: JSON.stringify(slices),
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
      },
    ]);
    const plan = await new SpidrFeaturePlanner({
      adapter,
      codebaseMap: codebaseMapFromRepo(root),
    }).decomposeSpec({ parentId: "epic_z", parentTier: "epic", spec });
    const result = await persistPlan(l, plan, { epicId: "epic_z", repoRoot: root });
    const W = workerPromptBudget(DEFAULT_TIER_BUDGET.workerWindowTokens);
    const fit = (card: Parameters<typeof zone3Fit>[0]) =>
      zone3Fit(card, { repoRoot: root, promptBudgetTokens: W });
    const board = new BoardServiceImpl(l.store, { entryConditions: true, zone3Fit: fit });

    // PM-N7-5: a card leaves Planning once a person approves its criteria.
    await approvePlan(l, "epic_z", l.store.localPrincipal());
    const statuses = new Map<string, string | undefined>();
    for (const c of result.created) statuses.set(c.id, (await l.store.getCard(c.id))?.status);
    const ready = result.created.filter((c) => statuses.get(c.id) === "ready");
    expect(ready.length).toBeGreaterThan(0);
    for (const c of ready) {
      const card = await l.store.getCard(c.id);
      const measured = fit(card as never);
      expect(measured.cap).toBe(3_792);
      expect(measured.tokens).toBe(c.zone3Tokens);
      expect(measured.tokens).toBeLessThanOrEqual(measured.cap);
      await board.transitionCard({
        cardId: c.id,
        fromStatus: "ready",
        toStatus: "planning",
        actor: "human",
        reason: "look again",
      });
      await board.transitionCard({
        cardId: c.id,
        fromStatus: "planning",
        toStatus: "ready",
        actor: "human",
        reason: "fits",
      });
      expect((await l.store.getCard(c.id))?.status).toBe("ready");
    }
  });

  it("a card over the cap is held by the planner, and the ready check agrees", async () => {
    const root = repo();
    const l = diskLedger();
    const spec = "Show the huge report rows.";
    await l.store.createCard({ id: "epic_h", tier: "epic", title: spec, status: "in_progress" });
    const plan = await new SpidrFeaturePlanner({
      codebaseMap: codebaseMapFromRepo(root),
    }).decomposeSpec({ parentId: "epic_h", parentTier: "epic", spec });
    const result = await persistPlan(l, plan, { epicId: "epic_h", repoRoot: root });
    const W = workerPromptBudget(DEFAULT_TIER_BUDGET.workerWindowTokens);
    const over = result.created.filter((c) => c.zone3Tokens > zone3Cap(W));
    expect(over.length).toBeGreaterThan(0);
    for (const c of over) {
      const card = await l.store.getCard(c.id);
      expect(card?.status).toBe("planning");
      expect(card?.blockedReason).toMatch(/Zone 3/);
      const measured = zone3Fit(card as never, { repoRoot: root, promptBudgetTokens: W });
      expect(measured.tokens).toBeGreaterThan(measured.cap);
    }
  });

  it("PM-14: the stored zone3Tokens counts the property and superseding files too, not only the base table", async () => {
    const root = repo();
    const l = diskLedger();
    const spec = "Refund a paid invoice.";
    await l.store.createCard({ id: "epic_inv", tier: "epic", title: spec, status: "in_progress" });
    const slices = {
      slices: [
        {
          kind: "path",
          title: "Refund a paid invoice",
          keywords: ["refund", "invoice"],
          rationale: "The refund path first.",
          // An invariant criterion (production/regulated stages a property
          // test for it, written to disk only after the card is created).
          criteria: [
            {
              text: "Refunding a paid invoice is idempotent: given a paid invoice of 1000 cents, refunding 400 twice leaves 600",
              examples: [{ args: [1000, 400], expected: 600 }],
            },
          ],
          interface: [
            {
              symbol: "refundInvoice",
              file: "src/refund.ts",
              signature: "refundInvoice(a: number, b: number): number",
            },
          ],
        },
      ],
    };
    const adapter = new MockInferenceAdapter(
      "planner",
      [
        {
          text: JSON.stringify(slices),
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
        } satisfies InferenceResponse,
      ],
      { exhaustion: "throw" },
    );
    const plan = await new SpidrFeaturePlanner({
      adapter,
      codebaseMap: codebaseMapFromRepo(root),
    }).decomposeSpec({ parentId: "epic_inv", parentTier: "epic", spec });
    const result = await persistPlan(l, plan, {
      epicId: "epic_inv",
      repoRoot: root,
      depthProfile: "production",
    });
    const id = result.created[0]?.id as string;
    const card = await l.store.getCard(id);
    expect(card?.acceptanceTests?.some((t) => /property/.test(t))).toBe(true);
    const W = workerPromptBudget(DEFAULT_TIER_BUDGET.workerWindowTokens);
    // Computed independently, after persist, when the property file is
    // already on disk: it must agree with what persist measured and stored.
    const fresh = zone3Fit(card as never, { repoRoot: root, promptBudgetTokens: W });
    expect(fresh.tokens).toBe(result.created[0]?.zone3Tokens);
  });
});

describe("N0 (c6 #7): Small at a window too small for any issue says so, never a negative cap", () => {
  it("clamps Zone 3's cap at zero when the prompt budget is under Zone 1", () => {
    // 8,192: W = 1,792, under Zone 1's 2,400, so 0.50 × (W − 2,400) would be −304.
    expect(workerPromptBudget(8_192)).toBe(1_792);
    expect(zone3Cap(workerPromptBudget(8_192))).toBe(0);
  });

  it("names the Coding model's window as too small instead of a negative cap", () => {
    const check = small([story("tiny", 200)], 8_192);
    expect(check?.passed).toBe(false);
    expect(check?.detail).not.toMatch(/-\d/);
    expect(check?.detail).toMatch(/window of 8,192 tokens is too small/);
  });
});

describe("N0 (c6 #7): Negotiable flags dictated lines, not a title that counts lines", () => {
  it("passes an outcome that mentions lines and a number", () => {
    for (const text of [
      "Count the lines of each of the 3 reports",
      "Keep each export under 500 lines",
      "Show the number of lines changed in 2 columns",
    ])
      expect(containsLineByLineDictation(text), text).toBe(false);
  });

  it("still flags a line number, a line range, verbatim text or a code fence", () => {
    for (const text of [
      "On line 42 change the constant",
      "Edit lines 10-20 of report.ts",
      "Replace lines 10 to 20",
      "Copy it verbatim into the 2 files",
      "Use exactly as written: 3 steps",
      "at line of the loop, add 1",
      "```ts\nconst a = 1;\n```",
    ])
      expect(containsLineByLineDictation(text), text).toBe(true);
  });
});
