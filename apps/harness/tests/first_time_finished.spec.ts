import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { describe, expect, it } from "vitest";
import { statusFacts } from "../src/status_api.js";

/**
 * Wave 8 A3 (dashboard §2.8 item 10, DB-N9-8; measurement: a figure is
 * re-derivable from the ledger). *Checks passed first time* is a share of
 * the period's finished issues the Agent built: of those, how many passed
 * their checks on its first try. It counted every first attempt in the
 * window, so a card still in review made "100% (1 of 1)" while the one
 * finished issue had no attempt at all.
 */
describe("checks passed first time counts finished issues (wave 8 A3)", () => {
  it("re-derives the share from the ledger: finished issues with a first Worker attempt", async () => {
    const db = new DatabaseSync(":memory:");
    initSchema(db);
    const log = new EventLog(db);
    const store = new CardStore(db, log);
    const p = (await store.ensureProject({ name: "Timesheets", rootPath: "/tmp/ft" })).id;
    const mk = (id: string) =>
      store.createCard({ id, tier: "task", title: id, status: "ready", projectId: p });
    const move = (id: string, to: string) =>
      store.updateCardStatus(id, to as never, "setup", "human", { override: true });
    const attempt = async (cardId: string, passed: boolean) => {
      const a = await store.runs.startAttempt({
        cardId,
        attemptNumber: store.runs.nextAttemptNumber(cardId),
        modelId: "m",
      });
      await store.runs.finishAttempt({
        attemptId: a.id,
        status: passed ? "passed" : "failed",
        stopReason: passed ? "gate_passed" : "budget_exhausted",
        tokensUsed: 1,
        secondsUsed: 1,
      });
    };
    for (const id of ["review1", "manual", "retried", "clean"]) await mk(id);
    // In review, passed first time: not finished, so not counted.
    await move("review1", "in_progress");
    await attempt("review1", true);
    await move("review1", "review");
    // Finished by hand with no attempt: nothing the Agent's checks say.
    await move("manual", "in_progress");
    await move("manual", "done");
    // Finished: failed first, then passed.
    await move("retried", "in_progress");
    await attempt("retried", false);
    await attempt("retried", true);
    await move("retried", "done");
    // Finished: passed first time.
    await move("clean", "in_progress");
    await attempt("clean", true);
    await move("clean", "done");

    // Re-derive: the finished issues, then each one's first attempt from the ledger.
    const events = await log.getEventsByTypes(["card/status_changed", "attempt/finished"]);
    const finished = new Set(
      events
        .filter((e) => (e.payload as { toStatus?: string }).toStatus === "done")
        .map((e) => String((e.payload as { id?: string }).id ?? e.cardId)),
    );
    const first = new Map<string, boolean>();
    for (const e of events.filter((e) => e.type === "attempt/finished")) {
      const f = e.payload as { cardId: string; status: string };
      if (!first.has(f.cardId)) first.set(f.cardId, f.status === "passed");
    }
    const counted = [...finished].filter((id) => first.has(id));
    const expected = {
      passed: counted.filter((id) => first.get(id)).length,
      total: counted.length,
    };
    expect(expected).toEqual({ passed: 1, total: 2 });

    const facts = await statusFacts({
      cardStore: store,
      log,
      me: log.localPrincipal(),
      project: p,
    });
    expect(facts.flow.finished).toBe(3);
    expect(facts.flow.firstTime).toEqual(expected);
    db.close();
  });
});
