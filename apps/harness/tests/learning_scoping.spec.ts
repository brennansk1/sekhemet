import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PlaybookRegistry } from "@sekhemet/context";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { learnFromAttempt, learnFromSendBack } from "../src/learning/reflect.js";
import {
  ROTATION_EVENT,
  creditRecords,
  playbookRuleOf,
  rankRules,
  scopeRefusal,
  standingErrorCode,
} from "../src/learning/scoping.js";
import { type LearnedRule, LearningStore, RULES_PER_PROMPT } from "../src/learning/store.js";

/**
 * NEW-context-4: rules scoped exactly, kept once, credited fairly
 * (context rule 24, 24b-24f; CX-N4-1..7). A real ledger file.
 */
describe("NEW-context-4: exact scoping, one curator, PM rules, rotation and paired credit", () => {
  let dir: string;
  let db: DatabaseSync;
  let log: EventLog;
  let cards: CardStore;
  let store: LearningStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "learn-scope-"));
    process.env.SEKHEMET_CONFIG_DIR = dir;
    db = new DatabaseSync(join(dir, "events.db"));
    initSchema(db);
    log = new EventLog(db);
    cards = new CardStore(db, log);
    store = new LearningStore(log);
  });
  afterEach(() => {
    Reflect.deleteProperty(process.env, "SEKHEMET_CONFIG_DIR");
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const evidence = [{ cardId: "c0", note: "failed then passed", verified: "execution" as const }];
  const approve = async (r: LearnedRule | undefined) => {
    if (!r) throw new Error("rule not written");
    await store.update(r.id, { status: "active" });
    return r;
  };

  describe("CX-N4-1: a rule that would reach every prompt is refused when written", () => {
    it("refuses an empty scope, an empty path pattern and a match-all pattern, naming the pattern", async () => {
      expect(scopeRefusal({})).toEqual({ code: "empty_scope" });
      expect(scopeRefusal({ pathPattern: "" })).toEqual({
        code: "empty_field",
        field: "pathPattern",
        pattern: "",
      });
      expect(scopeRefusal({ pathPattern: "src/" })).toEqual({
        code: "match_all",
        field: "pathPattern",
        pattern: "src/",
      });
      expect(scopeRefusal({ pathPattern: ".ts" }, ["src/a.ts", "test/b.ts"])).toEqual({
        code: "every_project_file",
        field: "pathPattern",
        pattern: ".ts",
      });
      expect(scopeRefusal({ pathPattern: "src/ledger" }, ["src/a.ts", "src/ledger.ts"])).toBe(
        undefined,
      );
      expect(scopeRefusal({ kind: "rule" })).toBeUndefined();

      const refused = await store.propose({
        role: "worker",
        text: "Keep functions small.",
        scope: { pathPattern: "src/" },
        source: "struggle",
        evidence,
      });
      expect(refused).toBeUndefined();
      expect(await store.rules()).toEqual([]);
      const [event] = await log.getEventsByTypes(["learn/rule_refused"]);
      expect(event?.payload).toMatchObject({ code: "match_all", pattern: "src/", role: "worker" });
    });

    it("checks a pattern against the project's files when the store knows them", async () => {
      const scoped = new LearningStore(log, undefined, {
        projectFiles: () => ["lib/a.ts", "lib/b.ts"],
      });
      expect(
        await scoped.propose({
          role: "worker",
          text: "Keep functions small.",
          scope: { pathPattern: "lib/" },
          source: "struggle",
          evidence,
        }),
      ).toBeUndefined();
    });
  });

  describe("CX-N4-2: kind, path, error and trigger gate combine with AND; the kind is cardKind's", () => {
    it("matches the card's kind and path at the card boundary, reading the stored kind", async () => {
      await approve(
        await store.propose({
          role: "worker",
          text: "Validate ledger rows before insert.",
          scope: { kind: "rule", pathPattern: "ledger" },
          source: "struggle",
          evidence,
        }),
      );
      // Stored kind `rule`, no SPIDR marker in the title.
      const hit = { title: "Guard the rows", kind: "rule" as const, scopeFiles: ["src/ledger.ts"] };
      expect(await store.activeFor("worker", hit)).toHaveLength(1);
      expect(await store.activeFor("worker", { ...hit, kind: "implement" })).toHaveLength(0);
      expect(
        await store.activeFor("worker", { ...hit, scopeFiles: ["src/other.ts"] }),
      ).toHaveLength(0);
      // A rule written before kinds were cardKind's ("Rule" from a SPIDR title) still reads.
      await approve(
        await store.propose({
          role: "worker",
          text: "Name every guard after its rule.",
          scope: { kind: "Rule" },
          source: "send_back",
          evidence,
        }),
      );
      expect(await store.activeFor("worker", hit)).toHaveLength(2);
    });

    it("applies an error pattern and a trigger gate only while both stand", () => {
      const rule = playbookRuleOf(
        {
          id: "r1",
          text: "Pass both arguments.",
          scope: { kind: "rule", errorPattern: "TS2554", triggerGate: "static" },
        },
        "Guard the rows",
      );
      const registry = new PlaybookRegistry(dir);
      registry.addTransientRule(rule);
      const match = (triggerGate?: string, failureText?: string) =>
        registry
          .matchRules({
            cardTitle: "Guard the rows",
            ...(triggerGate ? { triggerGate } : {}),
            ...(failureText ? { failureText } : {}),
          })
          .map((r) => r.id);
      expect(match("static", "a.ts:1:1 TS2554: Expected 2 arguments")).toEqual(["r1"]);
      expect(match("functional", "a.ts:1:1 TS2554: Expected 2 arguments")).toEqual([]);
      expect(match("static", "a.ts:1:1 TS2345: nope")).toEqual([]);
      expect(match(undefined, undefined)).toEqual([]);
    });
  });

  describe("CX-N4-3: more than eight: error code, value, recent evidence, id", () => {
    const rule = (id: string, value: number, at: string, errorPattern?: string): LearnedRule => ({
      id,
      role: "worker",
      text: id,
      scope: { kind: "rule", ...(errorPattern ? { errorPattern } : {}) },
      reach: "project",
      status: "active",
      helpful: 0,
      harmful: 0,
      value,
      source: "struggle",
      evidence: [{ note: "x", at }],
      createdAt: "2026-09-01T00:00:00Z",
    });
    it("takes the same eight whatever the ledger order", () => {
      const all = [
        rule("r_a", 1, "2026-09-02"),
        rule("r_b", 1, "2026-09-05"),
        rule("r_c", 3, "2026-09-01"),
        rule("r_d", 0, "2026-09-01", "TS2554"),
        rule("r_e", 2, "2026-09-01"),
        rule("r_f", 1, "2026-09-05"),
        rule("r_g", 0, "2026-09-01"),
        rule("r_h", -1, "2026-09-09"),
        rule("r_i", 5, "2026-09-01", "TS9999"),
        rule("r_j", -2, "2026-09-01"),
      ];
      const expected = ["r_d", "r_i", "r_c", "r_e", "r_b", "r_f", "r_a", "r_g"];
      expect(
        rankRules(all, { errorCode: "TS2554" })
          .slice(0, 8)
          .map((r) => r.id),
      ).toEqual(expected);
      expect(
        rankRules([...all].reverse(), { errorCode: "TS2554" })
          .slice(0, 8)
          .map((r) => r.id),
      ).toEqual(expected);
    });

    it("activeFor returns at most eight, ranked, the same on every call", async () => {
      const topics = [
        "alpha widgets",
        "bravo sockets",
        "charlie parsers",
        "delta caches",
        "echo queues",
        "foxtrot schemas",
        "golf routers",
        "hotel buffers",
        "india tokens",
        "juliet streams",
      ];
      for (const [i, topic] of topics.entries()) {
        await approve(
          await store.propose({
            role: "worker",
            text: `Handle ${topic} carefully.`,
            scope: { kind: "rule", pathPattern: `ledger${i % 2}` },
            source: "struggle",
            evidence,
          }),
        );
      }
      const card = {
        title: "t",
        kind: "rule" as const,
        scopeFiles: ["src/ledger0.ts", "src/ledger1.ts"],
      };
      const got = await store.activeFor("worker", card);
      expect(got).toHaveLength(8);
      expect(got).toEqual(rankRules(got, {}));
      expect((await store.activeFor("worker", card)).map((r) => r.id)).toEqual(
        got.map((r) => r.id),
      );
    });
  });

  describe("CX-N4-3 at the card boundary: the standing error code of the card's last attempt", () => {
    it("reads the last failing gate's code, and none for a card never run or that passed", async () => {
      await cards.createCard({ id: "e1", tier: "task", title: "e1" });
      expect(standingErrorCode(cards.runs, "e1")).toBeUndefined();
      const a = await cards.runs.startAttempt({ cardId: "e1", attemptNumber: 1, modelId: "m" });
      await cards.runs.recordGateResult({
        attemptId: a.id,
        cardId: "e1",
        gate: "typecheck",
        layer: "static",
        passed: false,
        exitCode: 2,
        durationMs: 1,
        failures: [{ errorExcerpt: "src/a.ts:1:1 TS2554: Expected 2 arguments" }],
        source: "local",
      });
      expect(standingErrorCode(cards.runs, "e1")).toBe("TS2554");
      const b = await cards.runs.startAttempt({ cardId: "e1", attemptNumber: 2, modelId: "m" });
      await cards.runs.recordGateResult({
        attemptId: b.id,
        cardId: "e1",
        gate: "typecheck",
        layer: "static",
        passed: true,
        exitCode: 0,
        durationMs: 1,
        failures: [],
        source: "local",
      });
      expect(standingErrorCode(cards.runs, "e1")).toBeUndefined();
    });
  });

  describe("CX-N4-4: one curator, one fact per key", () => {
    it("merges a candidate restating another candidate's key into it", async () => {
      const first = await store.propose({
        role: "worker",
        text: "TS2554 means a call is missing an argument: read the signature first.",
        scope: { kind: "rule", errorPattern: "TS2554" },
        source: "struggle",
        evidence,
      });
      const second = await store.propose({
        role: "worker",
        text: "When you see TS2554, check how many parameters the function takes.",
        scope: { kind: "implement", errorPattern: "TS2554" },
        source: "reflection",
        evidence: [{ cardId: "c9", note: "again", verified: "execution" }],
      });
      expect(second).toBeUndefined();
      const rules = await store.rules();
      expect(rules.map((r) => r.id)).toEqual([first?.id]);
      expect(rules[0]?.evidence.map((e) => e.cardId)).toEqual(["c0", "c9"]);
    });

    it("adds nothing for a fact a gate remedy already states", async () => {
      expect(
        await store.propose({
          role: "worker",
          text: "Narrow with a check before using a value that may be undefined (TS18048).",
          scope: { kind: "rule", errorPattern: "TS18048" },
          source: "struggle",
          evidence,
        }),
      ).toBeUndefined();
      expect(await store.rules()).toEqual([]);
    });
  });

  describe("CX-N4-5: PM rules reach Seshat, never the Worker", () => {
    it("writes a planning send-back as a PM rule, in Seshat's rules and in no Worker's", async () => {
      const card = await cards.createCard({ tier: "task", title: "Ledger", kind: "rule" });
      await learnFromSendBack(store, card, "This card should have been split into two cards");
      const [rule] = await store.rules();
      expect(rule).toMatchObject({ role: "manager", scope: { kind: "rule" } });
      await approve(rule);
      expect(await store.seshatRules()).toEqual([rule?.text]);
      expect(
        await store.activeFor("worker", { title: card.title, kind: "rule", scopeFiles: [] }),
      ).toEqual([]);
    });
  });

  describe("CX-N4-6: rotation across comparable cards, and paired credit from the attempt record", () => {
    const comparable = { projectId: "proj", cardClass: "rule:ts" };

    it("puts a rule in one comparable card's prompt and withholds it from the next, in start order, and records each", async () => {
      const rule = await approve(
        await store.propose({
          role: "worker",
          text: "Validate ledger rows before insert.",
          scope: { kind: "rule" },
          source: "struggle",
          evidence,
        }),
      );
      const decisions: string[] = [];
      for (const id of ["c1", "c2", "c3", "c4"]) {
        const r = await store.rotate([rule], { id, ...comparable }, 1);
        decisions.push(r.inPrompt.length === 1 ? "with" : "without");
      }
      expect(decisions).toEqual(["with", "without", "with", "without"]);
      // Another class is not comparable: its own rotation starts with the rule.
      const other = await store.rotate([rule], { id: "c5", projectId: "proj", cardClass: "x" }, 1);
      expect(other.inPrompt).toHaveLength(1);
      // A retry is not a first attempt: the rule stays in, nothing recorded.
      const retry = await store.rotate([rule], { id: "c2", ...comparable }, 2);
      expect(retry.inPrompt).toHaveLength(1);
      // The same card's first attempt keeps its decision.
      const again = await store.rotate([rule], { id: "c2", ...comparable }, 1);
      expect(again.withheld).toEqual([rule.id]);
      expect(await log.getEventsByTypes([ROTATION_EVENT])).toHaveLength(5);
      // Measurement runs rotate nothing (trials stay independent).
      const measured = await store.rotate([rule], { id: "c6", ...comparable }, 1, {
        measurement: true,
      });
      expect(measured.inPrompt).toHaveLength(1);
      expect(await log.getEventsByTypes([ROTATION_EVENT])).toHaveLength(5);
    });

    it("rotates only the rules the prompt's cap admits: a rule cut by the cap is neither with nor withheld", async () => {
      const texts = [
        "Validate ledger rows before insert.",
        "Prefer early returns over nested branches.",
        "Keep exported names stable across files.",
        "Quote shell arguments from user input.",
        "Close database handles in finally blocks.",
        "Sort map keys before hashing payloads.",
        "Name test cases after observable behaviour.",
        "Avoid floating point for currency amounts.",
        "Guard recursion with an explicit depth limit.",
        "Normalise line endings when comparing fixtures.",
      ];
      expect(texts.length).toBeGreaterThan(RULES_PER_PROMPT);
      const rules = [];
      for (const text of texts) {
        rules.push(
          await approve(
            await store.propose({
              role: "worker",
              text,
              scope: { kind: "rule" },
              source: "struggle",
              evidence,
            }),
          ),
        );
      }
      const r = await store.rotate(rules, { id: "cap1", ...comparable }, 1);
      const admitted = rules.slice(0, RULES_PER_PROMPT).map((x) => x.id);
      expect(r.inPrompt.length + r.withheld.length).toBe(RULES_PER_PROMPT);
      const [rotation] = await store.rotations();
      expect([...(rotation?.with ?? []), ...(rotation?.withheld ?? [])].sort()).toEqual(
        [...admitted].sort(),
      );
    });

    it("retires a harmful rule automatically at the 20-pair look, and reports insufficient data below it", async () => {
      const rule = await approve(
        await store.propose({
          role: "worker",
          text: "Always rewrite the whole file.",
          scope: { kind: "rule" },
          source: "struggle",
          evidence,
        }),
      );
      const runCard = async (n: number) => {
        const id = `k${n}`;
        await cards.createCard({ id, tier: "task", title: id, kind: "rule" });
        const r = await store.rotate([rule], { id, ...comparable }, 1);
        const withRule = r.inPrompt.length === 1;
        const a = await cards.runs.startAttempt({ cardId: id, attemptNumber: 1, modelId: "m" });
        // With the rule the card fails; without it, it passes.
        await cards.runs.finishAttempt({
          attemptId: a.id,
          status: withRule ? "failed" : "passed",
          stopReason: withRule ? "no_progress" : "gate_passed",
          tokensUsed: 1,
          secondsUsed: 1,
          ruleIds: withRule ? [rule.id] : [],
          ...comparable,
        });
      };
      for (let n = 0; n < 38; n++) await runCard(n);
      const outcomes = () => cards.runs.readAttemptOutcomes();
      let settled = await store.settleCredit(outcomes());
      expect(settled.find((c) => c.ruleId === rule.id)?.status).toBe("insufficient data");
      expect((await store.rules())[0]?.status).toBe("active");
      await runCard(38);
      await runCard(39);
      settled = await store.settleCredit(outcomes());
      expect(settled.find((c) => c.ruleId === rule.id)).toMatchObject({
        pairs: 20,
        harmful: 20,
        status: "retired",
      });
      const retired = (await store.rules())[0];
      expect(retired).toMatchObject({ status: "retired", helpful: 0, harmful: 20 });
      expect(retired?.evidence.at(-1)?.note).toMatch(/20 pairs.*P =/);
      // The credit reads the attempt record joined with the rotation, and nothing else.
      const records = creditRecords(outcomes(), await store.rotations());
      expect(records).toHaveLength(40);
      expect(records.filter((r) => r.withheldRules.includes(rule.id))).toHaveLength(20);
    });

    it("learnFromAttempt settles credit from the attempt record, not the card's own outcome", async () => {
      const card = await cards.createCard({ tier: "task", title: "Ledger", kind: "rule" });
      const rule = await approve(
        await store.propose({
          role: "worker",
          text: "Use exec for DDL.",
          scope: { kind: "rule" },
          source: "seed",
          evidence: [],
        }),
      );
      await learnFromAttempt(
        store,
        card,
        { passed: true, rulesUsed: [rule.id], lessons: { lines: [], struggles: [] } },
        1,
        { outcomes: () => cards.runs.readAttemptOutcomes() },
      );
      // One card is no pair: nothing is credited.
      expect((await store.rules())[0]).toMatchObject({ helpful: 0, harmful: 0 });
      expect(await log.getEventsByTypes(["learn/rule_outcome"])).toEqual([]);
    });
  });

  describe("CX-N4-7: probation is off", () => {
    it("applies no learned candidate before a person approves it, even when the run lists it", async () => {
      const learned = await store.propose({
        role: "worker",
        text: "Read the declaration before calling it.",
        scope: { kind: "rule" },
        source: "struggle",
        evidence,
      });
      const card = { title: "t", kind: "rule" as const, scopeFiles: [] };
      expect(
        await store.activeFor("worker", card, { runRules: new Set([learned?.id ?? ""]) }),
      ).toEqual([]);
      // A candidate a person seeded for this run (E5) is not learned: it applies.
      const seeded = await store.propose({
        role: "worker",
        text: "Prefer a discriminated union over a boolean pair.",
        scope: { kind: "rule" },
        source: "seed",
        evidence: [],
      });
      const got = await store.activeFor("worker", card, {
        runRules: new Set([learned?.id ?? "", seeded?.id ?? ""]),
      });
      expect(got.map((r) => r.id)).toEqual([seeded?.id]);
    });
  });
});
