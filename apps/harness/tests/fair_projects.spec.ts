import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type CardRecord, CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fairOrder } from "../src/team/fair_queue.js";

/**
 * Runtime item 4b, RUN-81 (DEC-57): one set of model engines shared by every
 * project of a workspace. Ready issues of several active projects start in
 * turn by project, each project's own order kept, under the per-person fair
 * share and cap; no project waits for more than one card of each other
 * project. Real SQLite.
 */
describe("fair turns across projects (RUN-81)", () => {
  let dir: string;
  let db: DatabaseSync;
  let store: CardStore;
  const project = async (name: string) => {
    const root = join(dir, name);
    mkdirSync(root);
    return (await store.ensureProject({ rootPath: realpathSync(root), name })).id;
  };
  const card = (id: string, projectId: string, owner = "p_a"): Promise<CardRecord> =>
    store.createCard({ id, tier: "task", title: id, status: "ready", projectId, owner });
  const drain = async (it: AsyncGenerator<CardRecord>) => {
    const out: string[] = [];
    for await (const c of it) out.push(c.id);
    return out;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sek-fair-projects-"));
    db = new DatabaseSync(join(dir, "events.db"));
    initSchema(db);
    store = new CardStore(db, new EventLog(db));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("takes turns by project, each project's order kept, so a long backlog never starves another", async () => {
    const a = await project("alpha");
    const b = await project("beta");
    const c = await project("gamma");
    // Alpha's backlog was planned first and is long.
    const cards = [
      await card("a1", a),
      await card("a2", a),
      await card("a3", a),
      await card("a4", a),
      await card("b1", b),
      await card("b2", b),
      await card("c1", c),
    ];
    const order = await drain(
      fairOrder(cards, { db, cardStore: store, cap: 5, maxWaitS: 600, sinceSeq: 0 }),
    );
    expect(order).toEqual(["a1", "b1", "c1", "a2", "b2", "a3", "a4"]);
  });

  it("keeps the per-person cap inside a project's turn (TEAM-30)", async () => {
    const a = await project("alpha");
    const b = await project("beta");
    await card("busy", a, "p_a");
    await store.updateCardStatus("busy", "in_progress", undefined, "human", { override: true });
    const cards = [
      await card("a1", a, "p_a"),
      await card("a2", a, "p_b"),
      await card("b1", b, "p_a"),
    ];
    const order = await drain(
      fairOrder(cards, { db, cardStore: store, cap: 1, maxWaitS: 600, sinceSeq: 0 }),
    );
    // p_a is at the cap: p_b's Alpha issue takes Alpha's turn, then Beta's.
    expect(order).toEqual(["a2", "b1", "a1"]);
  });
});
