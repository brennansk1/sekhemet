import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, describe, expect, it } from "vitest";
import {
  DecisionStore,
  MAX_OPEN_QUESTIONS_PER_PASS,
  type PlannerLedger,
  SpidrFeaturePlanner,
  backlogImpact,
  briefSources,
  buildDecisionRequest,
  designStage,
  playbookSources,
  questionPolicy,
  settleDesignQuestions,
  settledAnswerFor,
} from "../src/index.js";

/**
 * planner-pm §2.10.1, PM-P2-3, -5, -6: a spec is never refused as
 * under-specified; a planning pass asks at most two questions, the two whose
 * answers most change the backlog, and records the rest as assumptions with
 * their defaults; a question the playbook, the brief or an earlier decision
 * already settles is not asked, and its answer is recorded as the assumption
 * with its source. On-disk SQLite for the decisions (DEFINITION_OF_DONE §2A).
 */

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function ledger(): PlannerLedger {
  const dir = mkdtempSync(join(tmpdir(), "sek-questions-"));
  dirs.push(dir);
  const db = new DatabaseSync(join(dir, "events.db"));
  initSchema(db);
  const log = new EventLog(db);
  return { log, store: new CardStore(db, log) };
}

/** Five independent open points: alternatives, storage, API surface, authorization, vagueness. */
const FIVE =
  "A notes app that syncs to the cloud or to a local folder. Persist the notes in a backend. Maybe expose a public API. Admin roles can manage users. Make the sharing sensible.";

const plan = (
  spec: string,
  settled: Parameters<SpidrFeaturePlanner["decomposeSpec"]>[0]["settled"] = [],
) =>
  new SpidrFeaturePlanner().decomposeSpec({
    parentId: "epic_notes",
    parentTier: "epic",
    spec,
    settled,
  });

describe("PM-P2-5: a spec with four or more questions is still planned", () => {
  it("plans the five-question spec instead of refusing it", async () => {
    const p = await plan(FIVE);
    expect(p.rejected).toBe(false);
    expect(p.rejectionReason).toBeUndefined();
    expect(p.stories.length).toBeGreaterThan(0);
  });
});

describe("PM-P2-3: at most two questions per planning pass, the rest assumed", () => {
  it("asks the two whose answers most change the backlog and assumes the rest", async () => {
    expect(MAX_OPEN_QUESTIONS_PER_PASS).toBe(2);
    const p = await plan(FIVE);
    const asked = p.ambiguity.batch?.requests ?? [];
    expect(asked).toHaveLength(2);
    expect(p.ambiguity.decision?.id).toBe(asked[0]?.id);
    // The three not asked are assumptions, each with its default and why.
    const notAsked = p.ambiguity.assumptions.filter((a) => a.basis.startsWith("Not asked"));
    expect(notAsked).toHaveLength(3);
    const askedCategories = new Set(asked.map((r) => r.category));
    for (const a of notAsked) {
      expect(askedCategories.has(a.category)).toBe(false);
      expect(a.statement).toMatch(/^Assumed .+ for: /);
    }
    // Ranked: nothing assumed changes the backlog more than what was asked.
    const floor = Math.min(...asked.map(backlogImpact));
    for (const a of notAsked) {
      const was = (await new SpidrFeaturePlanner().classifyAmbiguity(FIVE)).batch?.requests.find(
        (r) => r.category === a.category,
      );
      expect(was).toBeDefined();
      if (was) expect(backlogImpact(was)).toBeLessThanOrEqual(floor);
    }
  });
});

describe("PM-P2-6: a question already settled is not asked", () => {
  it("an earlier decision's answer settles the same question", async () => {
    const l = ledger();
    const first = await plan(FIVE);
    const q = first.ambiguity.decision;
    expect(q).toBeDefined();
    if (!q) return;
    await l.store.createCard({ id: "epic_old", tier: "epic", title: "old", status: "in_progress" });
    const ds = new DecisionStore(l);
    const id = await ds.request({ ...q, cardId: "epic_old" });
    await ds.answer(id, 1, "human");
    const sources = await ds.settledSources();
    expect(sources.some((s) => s.kind === "decision" && s.ref === id)).toBe(true);

    const again = await plan(FIVE, sources);
    const asked = again.ambiguity.batch?.requests ?? [];
    expect(asked.some((r) => r.question === q.question)).toBe(false);
    const settled = again.ambiguity.assumptions.find((a) => a.basis.includes(id));
    expect(settled?.statement).toContain(q.options[1]?.label as string);
    expect(settled?.basis).toBe(`Settled by decision ${id}`);
    // Still at most two asked: the settled one's place goes to the next.
    expect(asked).toHaveLength(2);
  });

  it("the brief settles a safe_default question it answers; an assumed line does not", async () => {
    const first = await plan(FIVE);
    const q = first.ambiguity.batch?.requests.find((r) => r.policy === "safe_default");
    if (!q) throw new Error("expected a safe_default question");
    const answer = q.options[0]?.label as string;
    const assumedOnly = briefSources(`## Constraints\n- *Assumed:* ${q.question} ${answer}.\n`);
    expect(
      settledAnswerFor(
        { question: q.question, options: q.options.map((o) => o.label) },
        assumedOnly,
      ),
    ).toBeUndefined();
    const brief = briefSources(
      `## Constraints\n- ${q.question} ${answer}.\n`,
      "docs/product/brief.md",
    );
    const again = await plan(FIVE, brief);
    expect((again.ambiguity.batch?.requests ?? []).some((r) => r.question === q.question)).toBe(
      false,
    );
    const a = again.ambiguity.assumptions.find((x) => x.basis.startsWith("Settled by the brief"));
    expect(a?.statement).toContain(answer);
    expect(a?.basis).toBe("Settled by the brief (docs/product/brief.md)");
  });

  it("an approved playbook rule settles a design-stage question", () => {
    const design = designStage("A billing service that charges customers monthly", {
      greenfield: true,
    });
    const q = design.questions[0];
    expect(q).toBeDefined();
    if (!q) return;
    const pick = q.answers[q.answers.length - 1]?.answer as string;
    const rules = playbookSources([{ id: "rule_7", text: `${q.question} ${pick}.` }]);
    const out = settleDesignQuestions(design.questions, rules);
    expect(out.ask.map((x) => x.question)).not.toContain(q.question);
    expect(out.settled[0]).toEqual({
      question: q.question,
      answer: pick,
      source: "playbook",
      ref: "rule_7",
    });
  });
});

/** A `default_deny` request whose every option is destructive. */
const destructive = (x: string) =>
  buildDecisionRequest({
    cardId: "epic_x",
    category: "authorization",
    question: `Who may drop table ${x}?`,
    optionLabels: [`Drop table ${x}`, `Delete every row of ${x}`],
    sourceExcerpt: `drop table ${x}`,
  });

const ambiguityOf = (requests: ReturnType<typeof destructive>[]) => ({
  askUser: true,
  decision: requests[0],
  batch: { id: "batch_x", cardId: "epic_x", requests, createdAt: new Date(0).toISOString() },
  score: 1,
  findings: [],
  assumptions: [],
  spikes: [],
  rejected: false,
});

describe("PM-P2-3, PM-P2-4: a default_deny question is never assumed", () => {
  it("asks every default_deny question, past two, and records none as an assumption", () => {
    const reqs = ["a", "b", "c"].map(destructive);
    for (const r of reqs) {
      expect(r.policy).toBe("default_deny");
      expect(r.defaultIfNoAnswer.optionIndex).toBeUndefined();
    }
    const out = questionPolicy(ambiguityOf(reqs));
    expect((out.batch?.requests ?? []).map((r) => r.id).sort()).toEqual(
      reqs.map((r) => r.id).sort(),
    );
    expect(out.assumptions.filter((a) => a.basis.startsWith("Not asked"))).toEqual([]);
    expect(out.assumptions.some((a) => /Assumed Drop table/.test(a.statement))).toBe(false);
  });

  it("still assumes a safe_default question past the two asked", async () => {
    const safe = (await plan(FIVE)).ambiguity.assumptions.filter((a) =>
      a.basis.startsWith("Not asked"),
    );
    expect(safe.length).toBeGreaterThan(0);
  });
});

describe("PM-P2-6, DS-N3-2: a default_deny question is settled only from the ledger", () => {
  it("a brief line never settles it; a person's recorded decision does", () => {
    const q = destructive("accounts");
    const line = `${q.question} ${q.options[1]?.label}.`;
    const ask = { question: q.question, options: q.options.map((o) => o.label) };
    const out = questionPolicy(ambiguityOf([q]), {
      settled: briefSources(`## Constraints\n- ${line}\n`, "docs/product/brief.md"),
    });
    expect(out.batch?.requests.map((r) => r.id)).toEqual([q.id]);
    expect(out.settled ?? []).toEqual([]);
    expect(out.assumptions).toEqual([]);
    // The text alone still answers a safe_default question of the same words.
    expect(settledAnswerFor(ask, briefSources(line))?.answer).toBe(q.options[1]?.label);
    const byDecision = questionPolicy(ambiguityOf([q]), {
      settled: [
        {
          kind: "decision",
          ref: "dec_1",
          text: q.question,
          question: q.question,
          answer: q.options[0]?.label as string,
        },
      ],
    });
    expect(byDecision.batch).toBeUndefined();
    expect(byDecision.assumptions[0]?.basis).toBe("Settled by decision dec_1");
  });
});
