import { DatabaseSync } from "node:sqlite";
import { EventLog, initSchema } from "@sekhemet/kernel";
import { describe, expect, it } from "vitest";
import { scopeRefusal } from "../src/learning/scoping.js";
import { LearningStore } from "../src/learning/store.js";
import { candidateRuleFromEnv, researchRuleScope } from "../src/rule_scopes.js";
import { runFixtureGate } from "../src/wave2.js";

// CX-N4-1 on the queue's own proposals: the E5 candidate rule and the
// Researcher's rules carry a real scope, so they are admitted, not refused.

const store = () => {
  const db = new DatabaseSync(":memory:");
  initSchema(db);
  return new LearningStore(new EventLog(db));
};

describe("the queue's rule proposals are scoped (CX-N4-1)", () => {
  it("a Researcher's rule is scoped to the struggle's error code, else to the card's kind", async () => {
    const card = {
      id: "c1",
      title: "Ledger",
      kind: "data" as const,
      scopeFiles: ["src/ledger.ts"],
    };
    const byCode = researchRuleScope(
      card,
      "error TS2345: Argument of type 'string' is not assignable",
    );
    expect(byCode).toEqual({ errorPattern: "TS2345", kind: "data" });
    expect(scopeRefusal(byCode)).toBeUndefined();
    const byKind = researchRuleScope(card, "the test kept timing out");
    expect(byKind).toEqual({ kind: "data" });
    const s = store();
    const rule = await s.propose({
      role: "worker",
      text: "Pass a number, not a string, to the ledger's append.",
      scope: byCode,
      source: "research",
      evidence: [{ cardId: "c1", note: "TS2345", source: "gate", verified: "execution" }],
    });
    expect(rule?.scope).toEqual(byCode);
  });

  it("the E5 candidate rule carries the gated rule's own scope into the fixture run", async () => {
    const scope = { kind: "data", errorPattern: "TS2345" };
    const env = {
      SEKHEMET_CANDIDATE_RULE: "Use node:sqlite.",
      SEKHEMET_CANDIDATE_SCOPE: JSON.stringify(scope),
    };
    const candidate = candidateRuleFromEnv(env);
    expect(candidate).toEqual({ text: "Use node:sqlite.", scope });
    expect(scopeRefusal(candidate?.scope ?? {})).toBeUndefined();
    expect(candidateRuleFromEnv({ SEKHEMET_CANDIDATE_RULE: "x" })).toBeUndefined();
    const rule = await store().propose({
      role: "worker",
      text: candidate?.text ?? "",
      scope: candidate?.scope ?? {},
      source: "seed",
      evidence: [],
    });
    expect(rule).toBeDefined();
    // The gate passes the scope to the run.
    const calls: Record<string, string | undefined>[] = [];
    const spawn = async (_c: string, args: string[], e: Record<string, string | undefined>) => {
      calls.push(e);
      const out = args[args.indexOf("--out") + 1] as string;
      const { writeFileSync } = await import("node:fs");
      writeFileSync(
        out,
        JSON.stringify({
          suiteHash: "h",
          version: "1",
          passed: 1,
          total: 1,
          outcomes: [],
          cost: { wallClockSeconds: 1, tokens: 1, rungs: 0 },
          firstTry: 1,
          at: "",
        }),
      );
      return 0;
    };
    await runFixtureGate("/h", "chronicle", "Use node:sqlite.", [], spawn, scope);
    expect(calls[0]?.SEKHEMET_CANDIDATE_SCOPE).toBe(JSON.stringify(scope));
  });
});
