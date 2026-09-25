import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BlobStore,
  EventLog,
  initSchema,
  pruneRetention,
  serializeContextPack,
} from "../src/index.js";

describe("@sekhemet/kernel blobs by hash and retention (K26, K27)", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "kernel-blobs-"));
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("stores a context pack by content hash and refuses bytes that no longer match", () => {
    const blobs = new BlobStore(repo);
    const pack = serializeContextPack({
      step: 1,
      cardId: "c",
      modelId: "m",
      systemPrompt: "S",
      prompt: "P",
      tools: ["read_file"],
    });
    const id = blobs.put(pack);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(blobs.put(pack)).toBe(id);
    expect(blobs.get(id)).toBe(pack);
    // Key order does not change the id.
    expect(
      serializeContextPack({
        cardId: "c",
        tools: ["read_file"],
        prompt: "P",
        systemPrompt: "S",
        modelId: "m",
        step: 1,
      }),
    ).toBe(pack);
    writeFileSync(blobs.path(id), `${pack} tampered`);
    expect(blobs.get(id)).toBeUndefined();
  });

  it("prunes packs, observations and transcripts 30 days after a card closes, never evidence, as one recorded erasure (RUN-13, RUN-57)", async () => {
    const blobs = new BlobStore(repo);
    const oldPack = blobs.put("old");
    const shared = blobs.put("shared");
    const openPack = blobs.put("open");
    const dot = join(repo, ".sekhemet");
    mkdirSync(join(dot, "transcripts"), { recursive: true });
    mkdirSync(join(dot, "observations"), { recursive: true });
    mkdirSync(join(dot, "evidence"), { recursive: true });
    writeFileSync(join(dot, "transcripts", "card_old-2026-01-01T00-00-00-000Z.jsonl"), "{}");
    writeFileSync(join(dot, "transcripts", "card_open-2026-01-01T00-00-00-000Z.jsonl"), "{}");
    writeFileSync(
      join(dot, "observations", "ev-aaa.json"),
      JSON.stringify({ meta: { cardId: "card_old" } }),
    );
    writeFileSync(join(dot, "observations", "ev-aaa.txt"), "raw");
    writeFileSync(join(dot, "evidence", "ev_1.json"), "{}");

    const now = Date.parse("2026-09-18T00:00:00Z");
    const db = new DatabaseSync(join(dot, "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    const owner = log.ensureLocalPerson({});
    const report = await pruneRetention(
      repo,
      log,
      [
        {
          id: "card_old",
          status: "done",
          updatedAt: "2026-07-01T00:00:00Z",
          packIds: [oldPack, shared],
        },
        { id: "card_recent", status: "done", updatedAt: "2026-09-10T00:00:00Z", packIds: [] },
        {
          id: "card_open",
          status: "in_progress",
          updatedAt: "2026-01-01T00:00:00Z",
          packIds: [openPack, shared],
        },
      ],
      { now },
    );
    expect(report.closedCards).toEqual(["card_old"]);
    expect(report.removed).toEqual({ packs: 1, observations: 1, transcripts: 1 });
    expect(report.keptForOpenCards).toBe(1);
    expect(report.pruned).toEqual([
      { kind: "pack", id: oldPack, cardId: "card_old" },
      { kind: "transcript", id: "card_old-2026-01-01T00-00-00-000Z.jsonl", cardId: "card_old" },
      { kind: "observation", id: "ev-aaa", cardId: "card_old" },
    ]);
    const erased = (await log.getEvents(1, 100)).filter((e) => e.type === "ledger/erased");
    expect(erased).toHaveLength(1);
    expect(erased[0]?.seq).toBe(report.erasedBySeq);
    expect(erased[0]?.actor).toBe("harness");
    expect(erased[0]?.payload).toMatchObject({
      eventIds: [],
      blobIds: [oldPack],
      files: [
        "transcripts/card_old-2026-01-01T00-00-00-000Z.jsonl",
        "observations/ev-aaa.json",
        "observations/ev-aaa.txt",
      ],
      reason: "retention",
      principal: owner,
    });
    expect(log.blobErasure(oldPack)).toBe(report.erasedBySeq);
    expect((await log.verifyHashChain({ full: true })).valid).toBe(true);
    expect(existsSync(join(dot, "observations", "ev-aaa.txt"))).toBe(false);
    // Nothing due: no erasure recorded again.
    const again = await pruneRetention(repo, log, [], { now });
    expect(again.pruned).toEqual([]);
    expect((await log.getEvents(1, 100)).filter((e) => e.type === "ledger/erased")).toHaveLength(1);
    db.close();
    expect(blobs.has(oldPack)).toBe(false);
    expect(blobs.has(shared)).toBe(true);
    expect(blobs.has(openPack)).toBe(true);
    expect(existsSync(join(dot, "transcripts", "card_open-2026-01-01T00-00-00-000Z.jsonl"))).toBe(
      true,
    );
    expect(existsSync(join(dot, "evidence", "ev_1.json"))).toBe(true);
  });
});
