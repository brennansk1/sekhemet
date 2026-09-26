import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { type InferenceResponse, MockInferenceAdapter } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import {
  DecisionStore,
  EstimationModel,
  type PlannerLedger,
  SpidrFeaturePlanner,
  approvePlan,
  buildDecisionRequest,
  diagnoseEscalation,
  diffPlans,
  latestPlan,
  loadCalibrationLog,
  orderReadyCards,
  parsePrioritizationConfig,
  persistPlan,
  recordAssumptionOutcome,
  replanSession,
  reviewSession,
  standupReport,
} from "../src/index.js";
import type { DecisionRequest } from "../src/types.js";

/** An on-disk SQLite file per ledger (DEFINITION_OF_DONE §2A, PM-P1-14). */
const dbDirs: string[] = [];
afterEach(() => {
  while (dbDirs.length) rmSync(dbDirs.pop() as string, { recursive: true, force: true });
});

function ledger(): PlannerLedger {
  const dir = mkdtempSync(join(tmpdir(), "sek-planner-db-"));
  dbDirs.push(dir);
  const db = new DatabaseSync(join(dir, "events.db"));
  initSchema(db);
  const log = new EventLog(db);
  return { log, store: new CardStore(db, log) };
}

const SPEC =
  "Implement user authentication with JWT session cookies, password hashing, and rate limiting.";

async function planned(l: PlannerLedger, spec = SPEC) {
  await l.store.createCard({ id: "epic_auth", tier: "epic", title: spec, status: "in_progress" });
  const plan = await new SpidrFeaturePlanner().decomposeSpec({
    parentId: "epic_auth",
    parentTier: "epic",
    spec,
  });
  return { plan, result: await persistPlan(l, plan, { epicId: "epic_auth" }) };
}

describe("P1/P5/P6/P7: plans persist with their whole contract (defect 6)", () => {
  it("cards carry spec, criteria, difficulty, route, budgets and dependencies", async () => {
    const l = ledger();
    const { plan, result } = await planned(l);
    expect(result.created.length).toBe(plan.stories.length - result.rejected.length);
    for (const created of result.created) {
      const card = await l.store.getCard(created.id);
      const story = plan.stories.find((s) => s.card.id === created.id);
      expect(card?.spec).toContain(story?.card.title ?? "?");
      expect(card?.acceptanceCriteria?.length).toBeGreaterThan(0);
      expect(card?.difficulty).toBeGreaterThanOrEqual(1);
      expect(card?.difficulty).toBeLessThanOrEqual(10);
      expect(card?.modelRoute?.executor).toBeDefined();
      expect(card?.labels).toContain(story?.slice);
      expect(card?.tokenBudget).toBeGreaterThan(0);
      expect(card?.secondsBudget).toBeGreaterThan(0);
      expect(card?.parentId).toBe("epic_auth");
      if (story?.editSketch) {
        const dossier = await l.store.getDossier(created.id);
        expect(JSON.stringify(dossier)).toContain("Edit sketch from the planner");
      }
    }
    const withDeps = result.created.filter(
      (c) => (plan.stories.find((s) => s.card.id === c.id)?.dependsOn.length ?? 0) > 0,
    );
    for (const c of withDeps) {
      expect((await l.store.getCard(c.id))?.dependsOn?.length).toBeGreaterThan(0);
    }
    expect((await latestPlan(l, "epic_auth"))?.version).toBe(1);
  });
});

describe("P2: INVEST is enforced and shown", () => {
  it("serializes a story whose files overlap a card already in progress", async () => {
    const l = ledger();
    const plan = await new SpidrFeaturePlanner().decomposeSpec({
      parentId: "epic_auth",
      parentTier: "epic",
      spec: SPEC,
    });
    const target = plan.stories.find((s) => s.card.scopeFiles.length > 0);
    expect(target).toBeDefined();
    await l.store.createCard({
      id: "card_busy",
      tier: "task",
      title: "busy",
      status: "in_progress",
      scopeFiles: [target?.card.scopeFiles[0] as string],
    });
    await l.store.createCard({ id: "epic_auth", tier: "epic", title: SPEC, status: "in_progress" });
    const result = await persistPlan(l, plan, { epicId: "epic_auth" });
    expect(result.serialized.some((s) => s.after === "card_busy")).toBe(true);
    expect((await l.store.getCard(target?.card.id as string))?.dependsOn).toContain("card_busy");
    expect(result.invest.checks.find((c) => c.check === "independent")?.passed).toBe(false);
  });

  it("does not create a story INVEST rejects (orphan: advances nothing)", async () => {
    const l = ledger();
    const plan = await new SpidrFeaturePlanner().decomposeSpec({
      parentId: "epic_auth",
      parentTier: "epic",
      spec: SPEC,
    });
    const orphan = plan.stories[0];
    if (orphan) orphan.advances = [];
    await l.store.createCard({ id: "epic_auth", tier: "epic", title: SPEC, status: "in_progress" });
    const result = await persistPlan(l, plan, { epicId: "epic_auth" });
    expect(result.rejected.map((r) => r.id)).toEqual([orphan?.card.id]);
    expect(await l.store.getCard(orphan?.card.id as string)).toBeNull();
  });
});

function request(
  cardId: string,
  policy: "safe_default" | "default_deny",
  deadline: string,
): DecisionRequest {
  return {
    id: `req_${policy}`,
    cardId,
    question: "Which store?",
    options: [
      { label: "SQLite", consequence: "local", effortDelta: "+0", riskNote: "Low risk." },
      {
        label: "Postgres",
        consequence: "server",
        effortDelta: "+20 min",
        riskNote: "Needs a server.",
      },
    ],
    previewSketches: ["src/db.ts: sqlite adapter", "src/db.ts: pg adapter"],
    recommendation: { optionIndex: 0, rationale: "already a dependency" },
    policy,
    defaultIfNoAnswer: { optionIndex: 0, deadline },
    category: "storage",
    createdAt: "2026-09-18T00:00:00Z",
  };
}

describe("P9/P10/P11/P25: durable decision requests", () => {
  it("a safe_default request leaves its card where it is: work proceeds on the default", async () => {
    const l = ledger();
    await l.store.createCard({ id: "c0", tier: "task", title: "store", status: "ready" });
    const id = await new DecisionStore(l).request(
      request("c0", "safe_default", "2099-01-01T00:00:00Z"),
    );
    expect((await l.store.getCard("c0"))?.status).toBe("ready");
    expect(l.store.runs.getDecision(id)?.status).toBe("pending");
  });

  it("a default_deny request parks the card, survives a new store instance, and an answer resumes it", async () => {
    const l = ledger();
    await l.store.createCard({ id: "c1", tier: "task", title: "store", status: "ready" });
    const id = await new DecisionStore(l).request(
      request("c1", "default_deny", "2099-01-01T00:00:00Z"),
    );
    expect((await l.store.getCard("c1"))?.status).toBe("parked");
    // A fresh store over the same ledger sees the pending decision (restart).
    const again = new DecisionStore({ log: l.log, store: l.store });
    expect((await again.waiting()).map((d) => d.id)).toEqual([id]);
    const dossier = JSON.stringify(await l.store.getDossier("c1"));
    expect(dossier).toContain("Approach previews");
    await again.answer(id, 1);
    expect((await l.store.getCard("c1"))?.status).toBe("ready");
    expect((await l.store.getCard("c1"))?.blockedReason).toBeUndefined();
    expect(JSON.stringify(await l.store.getDossier("c1"))).toContain("Answer: Postgres");
    expect(l.store.runs.getDecision(id)?.selectedOptionIndex).toBe(1);
  });

  it("safe_default applies at the deadline; default_deny stays parked", async () => {
    const l = ledger();
    await l.store.createCard({ id: "a", tier: "task", title: "a", status: "ready" });
    await l.store.createCard({ id: "b", tier: "task", title: "b", status: "ready" });
    const ds = new DecisionStore(l);
    await ds.request(request("a", "safe_default", "2026-01-01T00:00:00Z"));
    await ds.request({ ...request("b", "default_deny", "2026-01-01T00:00:00Z"), id: "req_b" });
    const changed = await ds.sweepDeadlines(new Date("2026-02-01T00:00:00Z"));
    expect(changed.map((d) => `${d.record.cardId}:${d.state}`).sort()).toEqual([
      "a:default_applied",
      "b:parked",
    ]);
    expect((await l.store.getCard("a"))?.status).toBe("ready");
    expect((await l.store.getCard("b"))?.status).toBe("parked");
    // default_deny is still answerable by a human.
    const b = (await ds.waiting()).find((d) => d.record.cardId === "b");
    await ds.answer(b?.id as string, 0);
    expect((await l.store.getCard("b"))?.status).toBe("ready");
  });

  it("an ambiguous spec parks the epic and holds its stories in Planning until answered", async () => {
    const l = ledger();
    const spec =
      "Build a sync service for the notes app. Support cloud or local backends, maybe DynamoDB or SQLite, with retries.";
    await l.store.createCard({ id: "epic_auth", tier: "epic", title: spec, status: "in_progress" });
    const plan = await new SpidrFeaturePlanner().decomposeSpec({
      parentId: "epic_auth",
      parentTier: "epic",
      spec,
    });
    // The ask path with a default_deny decision built the planner's way:
    // only such a request parks its card from the request (kernel rule 27).
    plan.ambiguity.askUser = true;
    plan.ambiguity.decision = buildDecisionRequest({
      cardId: "epic_auth",
      category: "authorization",
      question: "Who may sync?",
      optionLabels: ["the owner only", "any member"],
      sourceExcerpt: "Support cloud or local backends",
    });
    expect(plan.ambiguity.decision.policy).toBe("default_deny");
    // One card whose criterion has an example: only the decision holds it.
    const ready = plan.stories.find((s) => s.slice === "interface") as (typeof plan.stories)[0];
    ready.acceptanceTests = [
      {
        filePath: "tests/notes_sync.spec.ts",
        assertion: "Given 2 notes, syncing 1 of them leaves 1 notes to sync",
        initiallyFailing: true,
        examples: [{ args: [2, 1], expected: 1 }],
      },
    ];
    const result = await persistPlan(l, plan, { epicId: "epic_auth" });
    expect(result.decisionId).toBeDefined();
    expect((await l.store.getCard("epic_auth"))?.status).toBe("parked");
    const first = result.created.find((c) => c.id === ready.card.id);
    expect(first?.status).toBe("planning");
    const other = result.created.find((c) => c.id !== ready.card.id);
    // PM-N7-5: a person approves the criteria; the decision's hold stays until it is answered.
    await approvePlan(l, "epic_auth", l.store.localPrincipal());
    expect((await l.store.getCard(first?.id as string))?.status).toBe("planning");
    await new DecisionStore(l).answer(result.decisionId as string, 0);
    expect((await l.store.getCard(first?.id as string))?.status).not.toBe("planning");
    // A card also held for its own reasons keeps them, without the decision's.
    const held = await l.store.getCard(other?.id as string);
    expect(held?.status).toBe("planning");
    expect(held?.blockedReason).not.toMatch(/Waiting on decision/);
    // Parked has no edge back into the middle of a state (kernel rule 25,
    // K-N5-6): an epic parked from In Progress is re-queued at Ready.
    expect((await l.store.getCard("epic_auth"))?.status).toBe("ready");
  });
});

describe("P4: estimation learns from written-back actuals", () => {
  it("uses the prior until a class has samples, then the measured median with a range", () => {
    const base = {
      tier: "story" as const,
      status: "done" as const,
      scopeFiles: [],
      stepBudget: 20,
      createdAt: "",
      updatedAt: "",
      labels: ["path"],
      difficulty: 4,
    };
    const cards = [1, 2, 3].map((i) => ({
      ...base,
      id: `d${i}`,
      title: `d${i}`,
      stepsUsed: 10 + i,
      tokensUsed: 40_000 * i,
      secondsUsed: 400 * i,
    }));
    const prior = new EstimationModel().estimate({
      tier: "story",
      labels: ["path"],
      difficulty: 4,
      basePackTokens: 2000,
      stepBudget: 20,
    });
    expect(prior.basis.kind).toBe("prior");
    const m = EstimationModel.fromCards(cards);
    const e = m.estimate({
      tier: "story",
      labels: ["path"],
      difficulty: 4,
      basePackTokens: 2000,
      stepBudget: 20,
    });
    expect(e.basis).toEqual({ kind: "measured", samples: 3, cardClass: "story:path:mid" });
    expect(e.tokens).toBe(2000 + 4 * 20_000);
    expect(e.seconds).toBe(800);
    expect(e.steps).toBe(12);
    expect(e.tokensRange[0]).toBeLessThan(e.tokens);
    expect(e.tokensRange[1]).toBeGreaterThan(e.tokens);
  });
});

describe("P3: WSJF / RICE ordering from config.toml", () => {
  const card = (id: string, priority: number, difficulty: number, labels: string[] = []) => ({
    id,
    tier: "task" as const,
    title: id,
    status: "ready" as const,
    scopeFiles: [],
    stepBudget: 10,
    stepsUsed: 0,
    createdAt: "",
    updatedAt: "",
    priority,
    difficulty,
    labels,
  });

  it("ranks by (value + criticality + risk) / (steps x difficulty); unconfigured keeps order", () => {
    const cfg = parsePrioritizationConfig({
      prioritization: {
        model: "wsjf",
        value_by_priority: { "1": 8, "2": 5, "3": 3, "4": 1 },
        risk_by_label: { security: 5 },
      },
    });
    const cards = [
      card("low", 4, 2),
      card("urgent_hard", 1, 8),
      card("secure", 3, 2, ["security"]),
      card("unset", 0, 2),
    ];
    const r = orderReadyCards(cards, cfg);
    expect(r.cards.map((c) => c.id)).toEqual(["secure", "urgent_hard", "low", "unset"]);
    expect(r.unscored).toEqual(["unset"]);
    expect(orderReadyCards(cards, undefined).cards.map((c) => c.id)).toEqual(
      cards.map((c) => c.id),
    );
    expect(parsePrioritizationConfig({})).toBeUndefined();
  });
});

describe("P15: calibration persists across processes", () => {
  it("override outcomes in the ledger shift a category to ask above 15%", async () => {
    const l = ledger();
    for (let i = 0; i < 5; i++) {
      await recordAssumptionOutcome(l, {
        assumptionId: `a${i}`,
        cardId: "none",
        category: "storage",
        overridden: i === 0,
        recordedAt: "2026-09-18T00:00:00Z",
      });
    }
    const log = await loadCalibrationLog(l);
    expect(log.calibrationFor("storage")).toMatchObject({
      observed: 5,
      overridden: 1,
      shifted: true,
    });
    const planner = new SpidrFeaturePlanner({ calibration: log });
    expect(planner.calibrationSnapshot().categories[0]?.disposition).toBe("ask");
  });
});

describe("P12/P13/P14: replan with diffs, review, standup, escalation", () => {
  it("records a new plan version with a diff; apply returns removed stories to Backlog", async () => {
    const l = ledger();
    await planned(l);
    const r = await replanSession(l, new SpidrFeaturePlanner(), {
      epicId: "epic_auth",
      spec: "Implement user authentication with JWT session cookies.",
      reason: "rate limiting moved to its own epic",
      trigger: "scope_change",
      apply: true,
    });
    expect(r.version).toBe(2);
    expect(r.diff.removed.length + r.diff.changed.length + r.diff.added.length).toBeGreaterThan(0);
    expect((await latestPlan(l, "epic_auth"))?.version).toBe(2);
    for (const id of r.parkedRemoved) {
      expect((await l.store.getCard(id))?.status).toBe("backlog");
      expect((await l.store.getCard(id))?.blockedReason).toMatch(/Removed by replan v2/);
    }
    const d = diffPlans(
      [
        {
          id: "a",
          title: "A",
          slice: "path",
          scopeFiles: ["x"],
          difficulty: 3,
          routing: "direct",
          dependsOn: [],
        },
      ],
      [
        {
          id: "b",
          title: "a",
          slice: "path",
          scopeFiles: ["y"],
          difficulty: 3,
          routing: "direct",
          dependsOn: [],
        },
      ],
    );
    expect(d.changed).toEqual([{ id: "b", title: "a", fields: ["scope"] }]);
  });

  it("review recommends return on a failing gate; standup lists decisions with wait times", async () => {
    const l = ledger();
    await l.store.createCard({ id: "r1", tier: "task", title: "review me" });
    await l.store.updateCardStatus("r1", "review", "test setup", "harness", { override: true });
    await l.log.append({
      actor: "executor",
      type: "gate/result",
      cardId: "r1",
      payload: { gate: "unit", status: "fail" },
    });
    expect((await reviewSession(l, "r1")).recommendation).toBe("return");
    await l.store.createCard({ id: "p1", tier: "task", title: "parked one", status: "ready" });
    await new DecisionStore(l).request(request("p1", "default_deny", "2099-01-01T00:00:00Z"));
    const s = await standupReport(l, { now: new Date(Date.now() + 3 * 3_600_000) });
    expect(s.text).toContain("Waiting on you:");
    expect(s.decisionsWaiting[0]?.waitingHours).toBeGreaterThanOrEqual(2.9);
    expect(s.text).toContain("In review:");
    expect(s.text).toContain("Parked:");
  });

  it("escalation names the smallest unblocking action from the failure text", () => {
    const card = {
      id: "e1",
      tier: "task" as const,
      title: "fetch rates",
      status: "parked" as const,
      scopeFiles: ["src/rates.ts"],
      stepBudget: 30,
      stepsUsed: 30,
      createdAt: "",
      updatedAt: "",
      stopReason: "repair_exhausted" as const,
    };
    const env = diagnoseEscalation(card, [
      {
        type: "gate/result",
        payload: { error: "Error: getaddrinfo ENOTFOUND api.rates.example" },
      } as never,
    ]);
    expect(env.category).toBe("external_dependency");
    expect(env.smallestHumanAction).toMatch(/service/);
    const ceiling = diagnoseEscalation(card, []);
    expect(ceiling.category).toBe("capability_ceiling");
    expect(ceiling.smallestHumanAction).toMatch(/Split it/);
  });
});

describe("BLOCKER, fixed: a model's interface symbol and file are validated before staging", () => {
  function repo(): string {
    const dir = mkdtempSync(join(tmpdir(), "sek-iface-safety-"));
    dbDirs.push(dir);
    return dir;
  }

  const reply = (text: string): InferenceResponse => ({
    text,
    toolCalls: [],
    usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
  });

  it("drops a symbol that is not a JS identifier and a file outside the repository", async () => {
    const root = repo();
    const adapter = new MockInferenceAdapter(
      "planner",
      [
        reply(
          JSON.stringify({
            slices: [
              {
                kind: "path",
                title: "Refund a paid invoice",
                keywords: ["refund", "invoice"],
                rationale: "the core behaviour",
                criteria: [
                  {
                    text: "Given a paid invoice of 1000 cents, refunding 400 leaves 600",
                    examples: [{ args: [1000, 400], expected: 600 }],
                  },
                ],
                interface: [
                  {
                    // Not a valid identifier: were it pasted raw into
                    // `import { X } from "..."` it would break out of the
                    // import and run arbitrary code at plan time.
                    symbol: 'x"); require("node:child_process").execSync("touch pwned"); //',
                    file: "../../../etc/passwd",
                    signature: "refundInvoice(paidCents: number, refundCents: number): number",
                  },
                ],
              },
            ],
          }),
        ),
      ],
      { exhaustion: "throw" },
    );
    const l = ledger();
    await l.store.createCard({
      id: "epic_p",
      tier: "epic",
      title: "Refunds",
      status: "in_progress",
    });
    const plan = await new SpidrFeaturePlanner({ adapter }).decomposeSpec({
      parentId: "epic_p",
      parentTier: "epic",
      spec: "Refund a paid invoice.",
    });
    const story = plan.stories[0];
    // The malicious entry never reaches the story's interface at all.
    expect(story?.interface ?? []).toEqual([]);

    const result = await persistPlan(l, plan, { epicId: "epic_p", repoRoot: root });
    const id = result.created[0]?.id as string;
    const card = await l.store.getCard(id);
    // A safe, heuristic symbol is used instead; nothing names "etc/passwd".
    expect(card?.interface?.every((s) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s.symbol))).toBe(true);
    expect(JSON.stringify(card?.interface ?? [])).not.toContain("passwd");

    // Nothing under the repo carries the payload: no file escaped it, and no
    // generated source contains the injection attempt verbatim.
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((n) => {
        const p = join(d, n);
        return statSync(p).isDirectory() ? walk(p) : [p];
      });
    for (const f of walk(root)) {
      expect(readFileSync(f, "utf8")).not.toContain("execSync");
    }
    expect(existsSync(join(root, "pwned"))).toBe(false);
  });
});
