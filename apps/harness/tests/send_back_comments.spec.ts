import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { dossierPromptLines } from "@sekhemet/loop";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sendBack } from "../src/triage.js";

/** worker-loop NEW-worker-loop-10 (WL-N10-4): line comments reach the next attempt. */
describe("a send-back with comments on diff lines (WL-N10-4)", () => {
  let dir: string;
  let db: DatabaseSync;
  let log: EventLog;
  let store: CardStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sendback-"));
    db = new DatabaseSync(join(dir, "events.db"));
    initSchema(db);
    log = new EventLog(db);
    store = new CardStore(db, log);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("puts each comment, with its file and line, into the next attempt's instructions", async () => {
    await store.createCard({ id: "c", tier: "story", title: "C", scopeFiles: ["src/**"] });
    await store.updateCardStatus("c", "review", "setup", "harness", { override: true });
    const board = new BoardServiceImpl(store);
    const card = await store.getCard("c");
    if (!card) throw new Error("no card");
    await sendBack(
      { repoPath: dir, cardStore: store, boardService: board, log },
      card,
      "two fixes",
      {
        comments: [
          { file: "src/total.ts", line: 12, text: "round half-even, not half-up" },
          { file: "src/total.ts", line: 30, text: "this branch is dead" },
        ],
      },
    );
    const lines = dossierPromptLines(await store.getDossier("c"));
    expect(lines).toContain("Sent back by the reviewer: two fixes");
    expect(lines).toContain(
      "Sent back by the reviewer: src/total.ts:12 — round half-even, not half-up",
    );
    expect(lines).toContain("Sent back by the reviewer: src/total.ts:30 — this branch is dead");
  });

  it("refuses a comment with no file or line", async () => {
    await store.createCard({ id: "d", tier: "story", title: "D", scopeFiles: ["src/**"] });
    await store.updateCardStatus("d", "review", "setup", "harness", { override: true });
    const card = await store.getCard("d");
    if (!card) throw new Error("no card");
    await expect(
      sendBack(
        { repoPath: dir, cardStore: store, boardService: new BoardServiceImpl(store), log },
        card,
        "fix",
        { comments: [{ file: "", line: 0, text: "x" }] },
      ),
    ).rejects.toThrow(/file and line/);
    expect((await store.getCard("d"))?.status).toBe("review");
  });
});
