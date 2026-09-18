import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { MockInferenceAdapter } from "@sekhemet/models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
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

  it("turns a struggle into a candidate rule that is inert until a human approves it", async () => {
    const card = await cards.createCard({ tier: "task", title: "Ledger (SPIDR: Rule)" });
    const proposed = await learnFromAttempt(
      store,
      card,
      {
        passed: true,
        rulesUsed: [],
        lessons: {
          lines: [],
          struggles: [{ text: "src/l.ts:9:5 TS2741: Property 'timestamp' is missing", edits: 2 }],
        },
      },
      1,
    );
    expect(proposed).toBe(1);
    const [rule] = await store.rules();
    expect(rule).toMatchObject({
      status: "candidate",
      source: "struggle",
      scope: { kind: "Rule", errorPattern: "TS2741" },
    });
    expect(await store.activeFor("worker", { title: card.title, scopeFiles: [] })).toEqual([]);

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

  it("lets Merit generalise the issues it called out into candidate rules", async () => {
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
});
