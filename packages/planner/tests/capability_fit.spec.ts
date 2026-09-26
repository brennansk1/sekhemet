import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type CardKind, CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, describe, expect, it } from "vitest";
import {
  CAPABILITY_MIN_ATTEMPTS,
  type PlannerLedger,
  SpidrFeaturePlanner,
  capabilityModel,
  capabilityModelOf,
  capabilityVerdict,
  persistPlan,
  predictPass,
  recordCapabilityFit,
} from "../src/index.js";

/**
 * Split to the measured horizon (planner-pm NEW-planner-pm-3, PM-N3-1…4):
 * from the ledger's attempt records, a kind with 10 or more first attempts
 * gets a logistic fit of pass probability against difficulty and changed
 * lines, and its 80% size horizon with an interval, recorded; a planned card
 * predicted under 0.6, or over the horizon, is split before it is scheduled;
 * under 10 attempts only the static bounds apply and the rate is marked
 * rough; a person's attempt is never in the model.
 */
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function diskLedger(): PlannerLedger {
  const dir = mkdtempSync(join(tmpdir(), "sek-capfit-"));
  dirs.push(dir);
  const db = new DatabaseSync(join(dir, "events.db"));
  initSchema(db);
  const log = new EventLog(db);
  return { log, store: new CardStore(db, log) };
}

/** One finished card: a first attempt with its size, by the Worker or a person. */
async function attempt(
  l: PlannerLedger,
  id: string,
  a: { kind: CardKind; difficulty: number; lines: number; passed: boolean; person?: boolean },
): Promise<void> {
  await l.store.createCard({
    id,
    tier: "story",
    title: id,
    status: "ready",
    kind: a.kind,
    difficulty: a.difficulty,
  });
  const started = await l.store.runs.startAttempt({
    cardId: id,
    attemptNumber: 1,
    modelId: "worker-m",
    ...(a.person ? { builtBy: { kind: "person" as const, id: "p_owner" } } : {}),
  });
  await l.store.runs.finishAttempt({
    attemptId: started.id,
    status: a.passed ? "passed" : "failed",
    stopReason: a.passed ? "gate_passed" : "repair_exhausted",
    tokensUsed: 100,
    secondsUsed: 1,
    linesAdded: a.lines,
  });
}

/** 24 implement attempts: small changes pass, large ones fail, with some overlap. */
async function measuredImplement(l: PlannerLedger): Promise<void> {
  const rows: [number, number, boolean][] = [
    [2, 10, true],
    [3, 15, true],
    [2, 20, true],
    [3, 25, true],
    [4, 30, true],
    [3, 35, true],
    [2, 40, true],
    [4, 45, true],
    [3, 50, true],
    [4, 55, false],
    [3, 60, true],
    [4, 70, true],
    [5, 80, false],
    [4, 90, true],
    [5, 100, false],
    [5, 110, false],
    [4, 120, false],
    [5, 130, true],
    [6, 140, false],
    [5, 150, false],
    [6, 160, false],
    [6, 180, false],
    [5, 190, false],
    [6, 200, false],
  ];
  for (const [i, [difficulty, lines, passed]] of rows.entries()) {
    await attempt(l, `impl_${i}`, { kind: "implement", difficulty, lines, passed });
  }
}

describe("PM-N3-1: a kind with 10 or more attempts is fitted, and its horizon recorded", () => {
  it("fits pass probability against difficulty and changed lines, with the 80% horizon and its interval", async () => {
    const l = diskLedger();
    await measuredImplement(l);
    const model = await capabilityModelOf(l);
    const impl = model.kinds.implement;
    expect(impl?.attempts).toBe(24);
    expect(impl?.rough).toBe(false);
    expect(impl?.fit).toBeDefined();
    // Larger changes pass less often: the lines coefficient is negative.
    expect(impl?.fit?.lines).toBeLessThan(0);
    const small = predictPass(impl as never, 3, 20) as number;
    const large = predictPass(impl as never, 5, 180) as number;
    expect(small).toBeGreaterThan(0.8);
    expect(large).toBeLessThan(0.3);
    // The 80% horizon sits where the record says small changes stop passing.
    const horizon = impl?.horizon80Lines as number;
    expect(horizon).toBeGreaterThan(20);
    expect(horizon).toBeLessThan(120);
    const [low, high] = impl?.horizonInterval as [number, number | null];
    expect(low).toBeLessThanOrEqual(horizon);
    expect(high === null || high >= horizon).toBe(true);
    // A pure function of the records: the same ledger gives the same fit.
    expect((await capabilityModelOf(l)).kinds.implement).toEqual(impl);

    await recordCapabilityFit(l, model);
    const fitted = await l.log.getEventsByTypes(["capability/fitted"]);
    expect(fitted).toHaveLength(1);
    expect(fitted[0]?.payload).toMatchObject({
      kind: "implement",
      attempts: 24,
      horizon80Lines: horizon,
    });
    // Recorded once per change in the record, not on every plan.
    await recordCapabilityFit(l, await capabilityModelOf(l));
    expect(await l.log.getEventsByTypes(["capability/fitted"])).toHaveLength(1);
  });
});

describe("PM-N3-2: a planned card predicted under 0.6, or over the horizon, is split before scheduling", () => {
  const SPEC =
    "Export every invoice to a PDF file, email the PDF to the customer, and archive the sent invoice.";

  it("the verdict names the prediction and the horizon", async () => {
    const l = diskLedger();
    await measuredImplement(l);
    const model = await capabilityModelOf(l);
    const big = capabilityVerdict(model, { kind: "implement", difficulty: 6 });
    expect(big.shouldSplit).toBe(true);
    expect(big.reason).toMatch(/predicted|horizon/);
    const low = capabilityVerdict(model, { kind: "implement", difficulty: 2 });
    expect(low.shouldSplit).toBe(false);
  });

  it("a harsh record splits every planned story or holds it in Planning; a kind the record says is fine is not split", async () => {
    const l = diskLedger();
    await l.store.createCard({ id: "epic_s", tier: "epic", title: SPEC, status: "in_progress" });
    // Every kind the planner writes has failed at every size: nothing fits.
    const harsh = capabilityModel(
      Array.from({ length: 12 }, (_, i) => ({
        seq: i + 1,
        attemptId: `a${i}`,
        cardId: `h${i}`,
        attemptNumber: 1,
        rung: 1,
        toolArm: "A",
        role: "worker",
        modelId: "m",
        status: "failed",
        passed: false,
        stopReason: "repair_exhausted",
        tokensUsed: 1,
        secondsUsed: 1,
        ruleIds: [],
        withheldRuleIds: [],
        exemplarIds: [],
        builtBy: { kind: "worker", id: "m" },
        linesAdded: 5 + i,
        completedAt: "",
      })) as never,
      Array.from({ length: 12 }, (_, i) => ({ id: `h${i}`, kind: "implement", difficulty: 2 })),
    );
    const planner = new SpidrFeaturePlanner();
    const plain = await planner.decomposeSpec({
      parentId: "epic_s",
      parentTier: "epic",
      spec: SPEC,
    });
    const plan = await planner.decomposeSpec({
      parentId: "epic_s",
      parentTier: "epic",
      spec: SPEC,
      capability: harsh,
    });
    const implement = plan.stories.filter((s) => s.slice === "path");
    expect(implement.length).toBeGreaterThan(0);
    const ceilinged = new Set(plan.capabilityCeilings.map((c) => c.storyId));
    for (const s of implement) {
      expect(s.splitDepth > 0 || ceilinged.has(s.card.id)).toBe(true);
    }
    // Other kinds have no record of their own: only the static bounds apply.
    const plainOthers = plain.stories.filter((s) => s.slice !== "path").map((s) => s.card.id);
    const others = plan.stories.filter((s) => s.slice !== "path").map((s) => s.card.id);
    expect(others).toEqual(plainOthers);

    const result = await persistPlan(l, plan, { epicId: "epic_s", capability: harsh });
    // Nothing fits this record, so what could not be split further waits in
    // Planning with the numbers rather than being scheduled.
    const persisted = implement.filter((s) => result.created.some((c) => c.id === s.card.id));
    expect(persisted.length).toBeGreaterThan(0);
    for (const s of persisted) {
      const held = result.held.find((h) => h.id === s.card.id);
      expect(held?.reasons.join(" ")).toMatch(/capability|predicted|horizon/i);
      expect((await l.store.getCard(s.card.id))?.status).toBe("planning");
    }
  });
});

describe("PM-N3-3: under 10 attempts only the static bounds apply, and the rate is rough", () => {
  it("marks the rate as a rough range and never splits on it", async () => {
    const l = diskLedger();
    for (let i = 0; i < CAPABILITY_MIN_ATTEMPTS - 1; i += 1) {
      await attempt(l, `d${i}`, { kind: "data", difficulty: 4, lines: 300, passed: false });
    }
    const model = await capabilityModelOf(l);
    const data = model.kinds.data;
    expect(data?.attempts).toBe(9);
    expect(data?.rough).toBe(true);
    expect(data?.fit).toBeUndefined();
    expect(data?.horizon80Lines).toBeUndefined();
    expect(data?.low).toBe(0);
    expect(data?.high).toBeGreaterThan(0.25);
    const verdict = capabilityVerdict(model, { kind: "data", difficulty: 9 });
    expect(verdict.shouldSplit).toBe(false);
    expect(verdict.note).toMatch(/rough/);
    await recordCapabilityFit(l, model);
    expect(await l.log.getEventsByTypes(["capability/fitted"])).toHaveLength(0);
  });
});

describe("PM-N3-4: a person's attempt is excluded from the capability model", () => {
  it("counts only the Worker's attempts", async () => {
    const l = diskLedger();
    await measuredImplement(l);
    for (let i = 0; i < 6; i += 1) {
      await attempt(l, `person_${i}`, {
        kind: "implement",
        difficulty: 6,
        lines: 400,
        passed: true,
        person: true,
      });
    }
    const model = await capabilityModelOf(l);
    expect(model.kinds.implement?.attempts).toBe(24);
    // The person's large passing changes did not move the horizon.
    const without = diskLedger();
    await measuredImplement(without);
    expect(model.kinds.implement?.horizon80Lines).toBe(
      (await capabilityModelOf(without)).kinds.implement?.horizon80Lines,
    );
  });
});
