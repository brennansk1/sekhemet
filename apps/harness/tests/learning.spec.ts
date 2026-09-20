import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, LifecycleHookEngine, initSchema } from "@sekhemet/kernel";
import { MockInferenceAdapter } from "@sekhemet/models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  consolidateWithManager,
  learnFromAttempt,
  learnFromProposalChoices,
  learnFromSendBack,
  reflectWithManager,
} from "../src/learning/reflect.js";
import { LearningStore } from "../src/learning/store.js";

describe("learning: playbook and user profile", () => {
  let configDir: string;
  let log: EventLog;
  let cards: CardStore;
  let store: LearningStore;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "learn-"));
    process.env.SEKHEMET_CONFIG_DIR = configDir;
    const db = new DatabaseSync(":memory:");
    initSchema(db);
    log = new EventLog(db);
    cards = new CardStore(db, log);
    store = new LearningStore(log);
  });
  afterEach(() => {
    Reflect.deleteProperty(process.env, "SEKHEMET_CONFIG_DIR");
    rmSync(configDir, { recursive: true, force: true });
  });

  it("turns a struggle into a candidate rule: inert, except for the run that learned it", async () => {
    const card = await cards.createCard({ tier: "task", title: "Ledger (SPIDR: Rule)" });
    const runRules = new Set<string>();
    const proposed = await learnFromAttempt(
      store,
      card,
      {
        passed: true,
        rulesUsed: [],
        lessons: {
          lines: [],
          struggles: [
            { text: "src/l.ts:9:5 TS2554: Expected 2 arguments, but got 1.", edits: 2 },
            // Has a built-in remedy: the failure block already says the fix.
            { text: "src/l.ts:9:5 TS2741: Property 'timestamp' is missing", edits: 2 },
          ],
        },
      },
      1,
      (id) => runRules.add(id),
    );
    expect(proposed).toBe(1);
    const [rule] = await store.rules();
    expect(rule).toMatchObject({
      status: "candidate",
      source: "struggle",
      scope: { kind: "Rule", errorPattern: "TS2554" },
    });
    // Not in force for a later run...
    expect(await store.activeFor("worker", { title: card.title, scopeFiles: [] })).toEqual([]);
    // ...but in force for the rest of the run that learned it.
    expect(
      (await store.activeFor("worker", { title: card.title, scopeFiles: [] }, runRules)).length,
    ).toBe(1);

    await store.update(rule?.id ?? "", { status: "active" });
    expect((await store.activeFor("worker", { title: card.title, scopeFiles: [] })).length).toBe(1);
  });

  it("counts helpful and harmful outcomes with a decaying value", async () => {
    const card = await cards.createCard({ tier: "task", title: "X" });
    const rule = await store.propose({
      role: "worker",
      text: "Use exec for DDL.",
      scope: {},
      source: "seed",
      evidence: [],
    });
    await store.update(rule?.id ?? "", { status: "active" });
    const run = (passed: boolean) =>
      learnFromAttempt(
        store,
        card,
        { passed, rulesUsed: [rule?.id ?? ""], lessons: { lines: [], struggles: [] } },
        1,
      );
    await run(true);
    await run(false);
    await run(false);
    const r = (await store.rules())[0];
    expect([r?.helpful, r?.harmful]).toEqual([1, 2]);
    expect(r?.value).toBeCloseTo(-1.09, 2);
  });

  it("promotes a rule to every project on approval, and does not duplicate", async () => {
    const rule = await store.propose({
      role: "worker",
      text: "End relative imports in .js.",
      scope: {},
      source: "seed",
      evidence: [],
    });
    await store.update(rule?.id ?? "", { status: "active", reach: "global" });
    // A different project (fresh ledger) sees the global rule.
    const other = new DatabaseSync(":memory:");
    initSchema(other);
    const elsewhere = new LearningStore(new EventLog(other));
    const found = await elsewhere.activeFor("worker", { title: "any", scopeFiles: [] });
    expect(found.map((r) => r.text)).toEqual(["End relative imports in .js."]);
    expect(
      await elsewhere.propose({
        role: "worker",
        text: "end relative imports in .JS",
        scope: {},
        source: "seed",
        evidence: [],
      }),
    ).toBeUndefined();
  });

  it("learns the user from send-backs and from proposal choices", async () => {
    const card = await cards.createCard({ tier: "task", title: "Api (SPIDR: Path)" });
    await learnFromSendBack(store, card, "Use named exports, never default exports");
    await learnFromProposalChoices(store, [
      { kind: "split_card", state: "discarded" },
      { kind: "split_card", state: "discarded" },
      { kind: "split_card", state: "discarded" },
      { kind: "update_card", state: "applied" },
    ]);
    const profile = await store.profile();
    expect(profile.map((p) => [p.category, p.source])).toEqual(
      expect.arrayContaining([
        ["code_style", "send_back"],
        ["planning", "proposal_choices"],
      ]),
    );
    expect(profile.find((p) => p.source === "proposal_choices")?.statement).toMatch(
      /declines .*splitting cards \(3 of 3\)/,
    );
    const entry = profile[0];
    await store.updateProfile(entry?.id ?? "", { status: "dismissed" });
    expect((await store.profile()).find((p) => p.id === entry?.id)?.status).toBe("dismissed");
  });

  it("lets Seshat generalise the issues it called out into candidate rules", async () => {
    const card = await cards.createCard({ tier: "task", title: "Ledger (SPIDR: Rule)" });
    const model = new MockInferenceAdapter("dirk-27b", [
      {
        text: '{"rules":[{"case":1,"text":"node:sqlite rows are untyped records; map each row to your type field by field.","reach":"global"}]}',
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
      },
    ]);
    const n = await reflectWithManager(model, store, [
      {
        card,
        plan: "Root cause: rows cast directly",
        firstStop: "repair_exhausted",
        retryPassed: false,
      },
    ]);
    expect(n).toBe(1);
    const [rule] = await store.rules();
    expect(rule).toMatchObject({ source: "reflection", status: "candidate" });
    expect(rule?.evidence[0]?.note).toMatch(/suggested reach: all projects/);
  });

  it("consolidates like Mem0: near-duplicates add evidence, related rules get a decision", async () => {
    await store.propose({
      role: "worker",
      text: "Use node:sqlite exec for DDL statements.",
      scope: {},
      source: "seed",
      evidence: [],
    });
    // Near-duplicate: NOOP at propose time, no second rule.
    expect(
      await store.propose({
        role: "worker",
        text: "use node:sqlite exec for DDL statements",
        scope: {},
        source: "seed",
        evidence: [],
      }),
    ).toBeUndefined();
    // Related but different: added, linked for Seshat to decide.
    const related = await store.propose({
      role: "worker",
      text: "Use node:sqlite prepare for inserts, not exec.",
      scope: {},
      source: "struggle",
      evidence: [],
    });
    expect(related?.related?.length).toBe(1);

    const model = new MockInferenceAdapter("dirk-27b", [
      {
        text: '{"decisions":[{"pair":1,"op":"UPDATE","merged":"Use node:sqlite exec for DDL and prepare(...).run for inserts."}]}',
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
      },
    ]);
    const c = await consolidateWithManager(model, store);
    expect(c.merged).toBe(1);
    const merged = (await store.rules()).find((r) => r.id === related?.id);
    expect(merged?.text).toBe("Use node:sqlite exec for DDL and prepare(...).run for inserts.");
    expect(merged?.evidence.at(-1)?.note).toMatch(/^merges/);
  });

  it("shows a proposed rule to the project's hooks, and honours a refusal (K12)", async () => {
    const engine = new LifecycleHookEngine();
    const seen: unknown[] = [];
    engine.register("playbook/propose", (ctx) => {
      seen.push(ctx.data?.rule);
      // A repository refusing a rule that contradicts its own conventions.
      const rule = ctx.data?.rule as { text: string };
      if (rule.text.includes("any")) return { block: true, reason: "no `any` in this repo" };
    });
    const hooked = new LearningStore(log, engine);

    const refused = await hooked.propose({
      role: "worker",
      text: "Widen the parameter to any when the type fights you.",
      scope: {},
      source: "struggle",
      evidence: [{ cardId: "card_x", note: "third time" }],
    });
    expect(refused).toBeUndefined();
    // Refused means not written: a later run must not find it in the playbook.
    expect(await hooked.rules()).toEqual([]);

    const allowed = await hooked.propose({
      role: "worker",
      text: "Prefer a discriminated union over a boolean pair.",
      scope: {},
      source: "struggle",
      evidence: [],
    });
    expect(allowed).toBeDefined();
    expect((await hooked.rules()).map((r) => r.id)).toEqual([allowed?.id]);

    // The hook saw the candidate as it would be stored, both times.
    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatchObject({ id: allowed?.id, status: "candidate", reach: "project" });
  });
});
