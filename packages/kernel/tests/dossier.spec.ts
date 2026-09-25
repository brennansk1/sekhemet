import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardStore, MAX_DOSSIER_TEXT } from "../src/card_store.js";
import { EventLog } from "../src/log.js";
import { type DiskDb, openDiskDb } from "./support/disk_db.js";

describe("@sekhemet/kernel card dossier", () => {
  let disk: DiskDb;
  let log: EventLog;
  let store: CardStore;

  beforeEach(async () => {
    disk = openDiskDb("sekhemet-dossier-");
    log = new EventLog(disk.db);
    store = new CardStore(disk.db, log);
    await store.createCard({ id: "c_a", tier: "task", title: "A", scopeFiles: ["src/a.ts"] });
    await store.createCard({ id: "c_b", tier: "task", title: "B", scopeFiles: ["src/b.ts"] });
  });
  afterEach(() => disk.dispose());

  it("writes every kind as a typed ledger event with the kind's default actor", async () => {
    await store.recordDossierEntry({
      cardId: "c_a",
      kind: "lesson",
      text: "TS2375 needs a spread",
      attempt: 1,
    });
    await store.recordDossierEntry({ cardId: "c_a", kind: "note", text: "Assumed: ids are UUIDs" });
    await store.recordDossierEntry({ cardId: "c_a", kind: "question", text: "Is seq 0-based?" });
    await store.recordDossierEntry({
      cardId: "c_a",
      kind: "research",
      text: "node:sqlite has no .pluck()",
      sources: ["https://nodejs.org/api/sqlite.html"],
    });
    await store.recordDossierEntry({
      cardId: "c_a",
      kind: "review",
      text: "Untested: empty log",
      verdict: "likely_send_back",
    });
    await store.recordDossierEntry({
      cardId: "c_a",
      kind: "send_back",
      text: "Handle the empty ledger",
    });

    const events = (await log.getEventsByCard("c_a")).filter((e) => e.type !== "card/created");
    expect(events.map((e) => [e.type, e.actor])).toEqual([
      ["card/lesson", "worker"],
      ["card/note", "worker"],
      ["card/question", "worker"],
      ["card/research", "researcher"],
      ["card/review", "reviewer"],
      ["card/send_back", "human"],
    ]);
    expect((await log.verifyHashChain()).valid).toBe(true);

    const dossier = await store.getDossier("c_a");
    expect(dossier.entries.map((e) => e.kind)).toEqual([
      "lesson",
      "note",
      "question",
      "research",
      "review",
      "send_back",
    ]);
    expect(dossier.lessons[0]).toMatchObject({
      text: "TS2375 needs a spread",
      attempt: 1,
      actor: "worker",
    });
    expect(dossier.research[0]?.sources).toEqual(["https://nodejs.org/api/sqlite.html"]);
    expect(dossier.reviews[0]?.verdict).toBe("likely_send_back");
    expect(dossier.sendBacks.map((e) => e.text)).toEqual(["Handle the empty ledger"]);
  });

  it("threads an answer under the question it names, never under another card's", async () => {
    const qa = await store.recordDossierEntry({
      cardId: "c_a",
      kind: "question",
      text: "Q for A?",
    });
    const qb = await store.recordDossierEntry({
      cardId: "c_b",
      kind: "question",
      text: "Q for B?",
    });
    await store.recordDossierEntry({
      cardId: "c_a",
      kind: "answer",
      text: "Answer for A",
      inReplyTo: qa.entryId,
    });
    await store.recordDossierEntry({
      cardId: "c_b",
      kind: "answer",
      text: "Answer for B",
      inReplyTo: qb.entryId,
    });
    // An answer filed on A that names B's question does not attach to A's thread.
    await store.recordDossierEntry({
      cardId: "c_a",
      kind: "answer",
      text: "Misfiled",
      inReplyTo: qb.entryId,
      actor: "human",
    });

    const a = await store.getDossier("c_a");
    expect(a.questions).toHaveLength(1);
    expect(a.questions[0]?.question.text).toBe("Q for A?");
    expect(a.questions[0]?.answers.map((x) => [x.text, x.actor])).toEqual([
      ["Answer for A", "manager"],
    ]);
    expect(a.unthreadedAnswers.map((x) => x.text)).toEqual(["Misfiled"]);

    const b = await store.getDossier("c_b");
    expect(b.questions[0]?.answers.map((x) => x.text)).toEqual(["Answer for B"]);
    expect(b.entries.some((e) => e.text === "Answer for A")).toBe(false);
  });

  it("survives a process restart: a new connection reads the same dossier", async () => {
    await store.recordDossierEntry({ cardId: "c_a", kind: "lesson", text: "persisted lesson" });
    disk.close();
    const reopened = new DatabaseSync(disk.path);
    try {
      const again = new CardStore(reopened, new EventLog(reopened));
      const dossier = await again.getDossier("c_a");
      expect(dossier.lessons.map((e) => e.text)).toEqual(["persisted lesson"]);
    } finally {
      reopened.close();
    }
  });

  it("rejects empty text, unknown kinds, bad attempts, stray replies and unknown cards", async () => {
    await expect(
      store.recordDossierEntry({ cardId: "c_a", kind: "note", text: "   " }),
    ).rejects.toThrow("needs non-empty text");
    await expect(
      store.recordDossierEntry({ cardId: "c_a", kind: "gossip" as never, text: "x" }),
    ).rejects.toThrow("Unknown dossier kind");
    await expect(
      store.recordDossierEntry({ cardId: "c_a", kind: "lesson", text: "x", attempt: 0 }),
    ).rejects.toThrow("positive integer");
    await expect(
      store.recordDossierEntry({ cardId: "c_a", kind: "note", text: "x", inReplyTo: "e1" }),
    ).rejects.toThrow("Only an answer");
    await expect(
      store.recordDossierEntry({ cardId: "c_missing", kind: "note", text: "x" }),
    ).rejects.toThrow("Card not found: c_missing");
    // Nothing was appended by any of the refusals.
    expect((await log.getEventsByCard("c_a")).map((e) => e.type)).toEqual(["card/created"]);
  });

  it("cuts oversized text with a visible marker and skips malformed ledger rows", async () => {
    const long = "x".repeat(MAX_DOSSIER_TEXT + 50);
    await store.recordDossierEntry({ cardId: "c_a", kind: "research", text: long });
    // A row written by an older or broken writer: right type, no text.
    await log.append({
      actor: "worker",
      type: "card/note",
      cardId: "c_a",
      payload: { kind: "note" },
    });

    const dossier = await store.getDossier("c_a");
    expect(dossier.notes).toEqual([]);
    const text = dossier.research[0]?.text ?? "";
    expect(text.startsWith("x".repeat(MAX_DOSSIER_TEXT))).toBe(true);
    expect(text.endsWith("[50 chars cut]")).toBe(true);
  });
});

describe("@sekhemet/kernel card actuals and checkpoints", () => {
  let disk: DiskDb;
  let store: CardStore;

  beforeEach(async () => {
    disk = openDiskDb("sekhemet-actuals-");
    store = new CardStore(disk.db, new EventLog(disk.db));
    await store.createCard({ id: "c_x", tier: "task", title: "X", scopeFiles: [] });
  });
  afterEach(() => disk.dispose());

  it("persists stop reason, tokens, seconds and evidence id, including the new reasons", async () => {
    const updated = await store.updateCard(
      "c_x",
      {
        stopReason: "time_budget_exhausted",
        tokensUsed: 12_345,
        secondsUsed: 97,
        evidenceId: "ev_0123456789",
        stepsUsed: 8,
      },
      "executor",
    );
    expect(updated).toMatchObject({
      stopReason: "time_budget_exhausted",
      tokensUsed: 12_345,
      secondsUsed: 97,
      evidenceId: "ev_0123456789",
      stepsUsed: 8,
    });
  });

  it("refuses an unknown stop reason or negative actuals without writing an event", async () => {
    const before = (await new EventLog(disk.db).getEvents()).length;
    await expect(store.updateCard("c_x", { stopReason: "gave_up" as never })).rejects.toThrow(
      "Unknown stop reason: gave_up",
    );
    await expect(store.updateCard("c_x", { tokensUsed: -1 })).rejects.toThrow("non-negative");
    await expect(store.updateCard("c_x", { secondsUsed: Number.NaN })).rejects.toThrow(
      "non-negative",
    );
    expect((await new EventLog(disk.db).getEvents()).length).toBe(before);
  });

  it("refuses malformed checkpoints and checkpoints for a card that does not exist", async () => {
    const base = {
      cardId: "c_x",
      step: 3,
      gitRef: "abc123",
      gateStatus: "partial" as const,
      agentModel: "m",
      agentHarness: "sekhemet",
      agentRole: "implementer" as const,
      createdAt: new Date().toISOString(),
    };
    await expect(store.recordCheckpoint({ ...base, step: -1 })).rejects.toThrow(
      "non-negative integer",
    );
    await expect(store.recordCheckpoint({ ...base, gitRef: " " })).rejects.toThrow(
      "needs a git ref",
    );
    await expect(store.recordCheckpoint({ ...base, gateStatus: "green" as never })).rejects.toThrow(
      "Unknown checkpoint gate status",
    );
    const events = new EventLog(disk.db);
    const before = (await events.getEvents()).length;
    await expect(store.recordCheckpoint({ ...base, cardId: "c_nope" })).rejects.toThrow(
      "Card not found: c_nope",
    );
    expect((await events.getEvents()).length).toBe(before);
    await store.recordCheckpoint(base);
    // K-N6-4: a checkpoint records who built it, the Worker by default.
    expect(await store.getCheckpoints("c_x")).toEqual([
      { ...base, builtBy: { kind: "worker", id: base.agentModel } },
    ]);
  });
});
