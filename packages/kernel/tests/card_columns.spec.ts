import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CARD_COLUMN_TABLE, type CardColumn, cardPatchAssignments } from "../src/card_columns.js";
import { CardStore } from "../src/card_store.js";
import { EventLog } from "../src/log.js";
import { type DiskDb, openDiskDb } from "./support/disk_db.js";

// kernel.md rule 38, K-N4-4: the card store's column list, row, insert and
// update all come from the one column table. Real SQLite files (DoD §2A).

describe("K-N4-4: the card store reads and writes through the column table", () => {
  it("puts a patchable column added to the table into a card/updated projection", () => {
    const extra: CardColumn = {
      column: "fixture_note",
      ddl: "fixture_note TEXT",
      fromPayload: (p) => (p.fixtureNote as string | undefined) ?? null,
      patchKey: "fixtureNote",
    };
    const table = [...CARD_COLUMN_TABLE, extra];
    expect(cardPatchAssignments({ fixtureNote: "n", title: "T" }, table)).toEqual([
      ["title", "T"],
      ["fixture_note", "n"],
    ]);
    // A column no patch may write is never assigned, whatever the patch says.
    expect(cardPatchAssignments({ status: "done", id: "x", tier: "epic" }, table)).toEqual([]);
  });

  describe("on a real database", () => {
    let disk: DiskDb;
    let store: CardStore;
    beforeEach(() => {
      disk = openDiskDb("sekhemet-cols-");
      store = new CardStore(disk.db, new EventLog(disk.db));
    });
    afterEach(() => disk.dispose());

    it("round-trips every patchable field, live and replayed, identically", async () => {
      await store.createCard({ id: "dep", tier: "task", title: "Dep" });
      await store.createCard({ id: "c", tier: "task", title: "C" });
      const updated = await store.updateCard("c", {
        title: "C2",
        scopeFiles: ["src/a.ts"],
        stepBudget: 12,
        stepsUsed: 3,
        spec: "do it",
        acceptanceCriteria: ["a"],
        acceptanceTests: ["t"],
        difficulty: 4,
        tokenBudget: 100,
        secondsBudget: 60,
        tokensUsed: 7,
        secondsUsed: 8,
        modelRoute: { planner: "p", executor: "e" },
        dependsOn: ["dep"],
        contextPackId: "pk",
        evidenceId: "ev",
        externalRef: { system: "github", id: "1" } as never,
        stopReason: "no_progress",
        priority: 2,
        orderKey: "a5",
        blockedReason: "b",
        estimate: 3,
        labels: ["x"],
        epicId: "e1",
        cycleId: "c1",
        assignee: "worker",
        dueDate: "2026-10-01",
      });
      expect(updated).toMatchObject({
        title: "C2",
        scopeFiles: ["src/a.ts"],
        stepBudget: 12,
        difficulty: 4,
        modelRoute: { planner: "p", executor: "e" },
        dependsOn: ["dep"],
        externalRef: { system: "github", id: "1" },
        stopReason: "no_progress",
        orderKey: "a5",
        labels: ["x"],
        dueDate: "2026-10-01",
      });
      await store.updateCard("c", { estimate: null, blockedReason: null });
      const cleared = await store.getCard("c");
      expect(cleared?.estimate).toBeUndefined();
      expect(cleared?.blockedReason).toBeUndefined();
      expect((await store.verifyProjections()).identical).toBe(true);
    });
  });
});
