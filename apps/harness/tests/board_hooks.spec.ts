import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { watchBoardHooks } from "../src/board_hooks.js";
import { setInvocationTrust } from "../src/workspace_trust.js";

/**
 * extensibility NEW-extensibility-1 — board-lifecycle hooks: a real ledger
 * file, real shell hooks.
 */
beforeAll(() => setInvocationTrust(true));
afterAll(() => setInvocationTrust(false));

let repo: string;
let db: DatabaseSync;
let log: EventLog;
let store: CardStore;
let board: BoardServiceImpl;
beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "sek-board-hooks-"));
  mkdirSync(join(repo, ".sekhemet"), { recursive: true });
  vi.stubEnv("SEKHEMET_CONFIG_DIR", join(repo, "user"));
  db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
  initSchema(db);
  log = new EventLog(db);
  store = new CardStore(db, log);
  board = new BoardServiceImpl(store);
  await store.createCard({ id: "c1", tier: "story", title: "Card c1" });
});
afterEach(() => {
  vi.unstubAllEnvs();
  db.close();
  rmSync(repo, { recursive: true, force: true });
});

const hooks = (toml: string) => writeFileSync(join(repo, ".sekhemet", "hooks.toml"), toml);

describe("EXT-8: card/accepted hooks run once with the card, the merge commit and the person", () => {
  it("passes the card id, the sha and the accepting person on stdin", async () => {
    const out = join(repo, "accepted.jsonl");
    hooks(`[[hook]]\nevent = "card/accepted"\ncommand = "cat >> ${out}; echo >> ${out}"\n`);
    const watcher = watchBoardHooks(log, store, repo);
    await store.recordEvent({
      type: "card/accepted",
      cardId: "c1",
      actor: "human",
      principal: store.localPrincipal(),
      payload: { id: "c1", sha: "a".repeat(40), principal: store.localPrincipal() },
    });
    await watcher.idle();
    watcher.stop();
    const runs = readFileSync(out, "utf8").trim().split("\n");
    expect(runs).toHaveLength(1);
    expect(JSON.parse(runs[0] as string)).toMatchObject({
      cardId: "c1",
      data: { id: "c1", sha: "a".repeat(40), principal: store.localPrincipal() },
    });
  });
});

describe("EXT-9: a board-lifecycle hook observes; its objection is recorded on the card", () => {
  it("keeps the transition when a card/status_changed hook exits 2, and records its stderr", async () => {
    hooks(
      '[[hook]]\nevent = "card/status_changed"\nname = "tracker sync"\ncommand = "echo \'tracker rejected the move\' >&2; exit 2"\n',
    );
    const watcher = watchBoardHooks(log, store, repo);
    await board.transitionCard({
      cardId: "c1",
      fromStatus: "ready",
      toStatus: "backlog",
      actor: "human",
      principal: store.localPrincipal(),
      reason: "planned",
    });
    await watcher.idle();
    watcher.stop();
    expect((await store.getCard("c1"))?.status).toBe("backlog");
    const dossier = await store.getDossier("c1");
    const note = dossier.entries.find((e) => e.text.includes("tracker rejected the move"));
    expect(note?.text).toMatch(/tracker sync.*card\/status_changed/);
  });

  it("does nothing when no board hook is declared", async () => {
    const watcher = watchBoardHooks(log, store, repo);
    await board.transitionCard({
      cardId: "c1",
      fromStatus: "ready",
      toStatus: "backlog",
      actor: "human",
      principal: store.localPrincipal(),
      reason: "planned",
    });
    await watcher.idle();
    watcher.stop();
    expect((await store.getDossier("c1")).entries).toEqual([]);
  });
});
