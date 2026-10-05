import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BlobStore } from "../src/blobs.js";
import { CardStore, CardStructureError } from "../src/card_store.js";
import { EventLog, ledgerErasures } from "../src/log.js";
import { type DiskDb, openDiskDb } from "./support/disk_db.js";

// kernel rule 38a, NEW-kernel-12 (C2b's part): a card names its project once a
// workspace holds more than one (K-N12-3), roots never nest (K-N12-6), and a
// root moves only by a person's recorded move (K-N12-7). Real SQLite files.

describe("a workspace of many projects (K-N12-3, K-N12-6, K-N12-7)", () => {
  let disk: DiskDb;
  let log: EventLog;
  let store: CardStore;
  let ws: string;
  beforeEach(() => {
    disk = openDiskDb("sekhemet-workspace-");
    ws = realpathSync(disk.dir);
    log = new EventLog(disk.db);
    store = new CardStore(disk.db, log);
  });
  afterEach(() => disk.dispose());

  const folder = (...parts: string[]): string => {
    const dir = join(ws, ...parts);
    mkdirSync(dir, { recursive: true });
    return realpathSync(dir);
  };
  const eventCount = async (): Promise<number> => (await log.getEvents(1, 100_000)).length;

  it("K-N12-3: with one project a card without one joins it; with two it is refused with project_required before appending", async () => {
    const a = await store.ensureProject({ rootPath: folder("a"), name: "A" });
    await store.createCard({ id: "c1", tier: "story", title: "One" });
    expect((await store.getCard("c1"))?.projectId).toBe(a.id);
    const b = await store.ensureProject({ rootPath: folder("b"), name: "B" });
    const before = await eventCount();
    const refused = await store
      .createCard({ id: "c2", tier: "story", title: "Two" })
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(CardStructureError);
    expect((refused as CardStructureError).code).toBe("project_required");
    expect(await eventCount()).toBe(before);
    expect(await store.getCard("c2")).toBeNull();
    await store.createCard({ id: "c3", tier: "story", title: "Three", projectId: b.id });
    expect((await store.getCard("c3"))?.projectId).toBe(b.id);
  });

  it("K-N12-3: a card recorded with no project is read as the workspace folder's project, else the first, without appending", async () => {
    // Recorded before any project existed: its row carries no project.
    await store.createCard({ id: "old", tier: "story", title: "Old" });
    disk.db.prepare("UPDATE cards SET project_id = NULL WHERE id = 'old'").run();
    const other = await store.ensureProject({ rootPath: folder("p-other"), name: "Other" });
    expect((await store.getCard("old"))?.projectId).toBe(other.id);
    const head = store.ledgerHead();
    // The workspace folder's own project wins once the store knows the folder.
    const own = await store.ensureProject({ rootPath: folder("ws"), name: "Own" });
    store.workspaceFolder = folder("ws");
    const afterOwn = store.ledgerHead();
    expect((await store.getCard("old"))?.projectId).toBe(own.id);
    expect((await store.listCards()).find((c) => c.id === "old")?.projectId).toBe(own.id);
    expect(store.ledgerHead()).toBe(afterOwn);
    expect(head).not.toBe(afterOwn);
    // Replay keeps the row as recorded: still no project in the projection.
    const row = disk.db.prepare("SELECT project_id FROM cards WHERE id = 'old'").get() as {
      project_id: string | null;
    };
    expect(row.project_id).toBeNull();
  });

  it("K-N12-6: a root inside another project's root, or containing one, is refused with project_nested before appending", async () => {
    const outer = folder("outer");
    const a = await store.ensureProject({ rootPath: outer, name: "A" });
    const before = await eventCount();
    for (const root of [folder("outer", "inner"), ws]) {
      const err = await store.ensureProject({ rootPath: root, name: "X" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CardStructureError);
      expect((err as CardStructureError).code).toBe("project_nested");
      expect((err as Error).message).toContain("A");
    }
    expect(await eventCount()).toBe(before);
    // A sibling whose name only starts with the other's is not nested.
    const sibling = await store.ensureProject({ rootPath: folder("outer-two"), name: "B" });
    expect(sibling.id).not.toBe(a.id);
    // The same folder is the same project, never a nesting.
    expect((await store.ensureProject({ rootPath: outer, name: "A" })).id).toBe(a.id);
  });

  it("TEAM-54/56: project/created records how the project came and who approved it", async () => {
    const p = await store.ensureProject({
      rootPath: folder("fresh"),
      name: "Fresh",
      via: "new_folder",
      principal: "p_owner",
    });
    const events = await log.getEvents(1, 100);
    const created = events.find((e) => e.type === "project/created");
    expect(created?.payload).toMatchObject({ id: p.id, via: "new_folder", rootPath: p.rootPath });
    expect(created?.principal).toBe("p_owner");
  });

  it("K-N12-7: a move records project/updated {id, rootPath} with the person's principal after the check, and refuses otherwise", async () => {
    const a = await store.ensureProject({ rootPath: folder("old-home"), name: "A" });
    const b = await store.ensureProject({ rootPath: folder("b-home"), name: "B" });
    const target = folder("new-home");
    const before = await eventCount();
    // No principal: a root moves only by a person.
    await expect(
      store.moveProject(a.id, target, { principal: "", check: () => undefined }),
    ).rejects.toThrow(/person/);
    // The repository check fails: nothing recorded, the reason named.
    await expect(
      store.moveProject(a.id, target, {
        principal: "p_owner",
        check: () => "the folder's history lacks the accepted merge abc1234",
      }),
    ).rejects.toThrow(/abc1234/);
    // Nesting inside B: project_nested.
    const nested = await store
      .moveProject(a.id, folder("b-home", "inside"), {
        principal: "p_owner",
        check: () => undefined,
      })
      .catch((e: unknown) => e);
    expect((nested as CardStructureError).code).toBe("project_nested");
    expect(await eventCount()).toBe(before);
    const moved = await store.moveProject(a.id, target, {
      principal: "p_owner",
      check: () => undefined,
    });
    expect(moved.rootPath).toBe(target);
    expect(store.getProject(b.id)?.rootPath).toBe(b.rootPath);
    const events = await log.getEvents(1, 1000);
    const update = events.at(-1);
    expect(update?.type).toBe("project/updated");
    expect(update?.payload).toMatchObject({ id: a.id, rootPath: target });
    expect(update?.principal).toBe("p_owner");
    // Replay reproduces the new root.
    await store.rebuildProjections();
    expect(store.getProject(a.id)?.rootPath).toBe(target);
    expect(store.getProject(a.id)?.status).toBe("active");
  });
});

// kernel rule 38a, NEW-kernel-12 (C4's part): one erasure covers every
// project's events, and a replay of either project's step names its gap
// (K-N12-5). Real SQLite files and a real blob store.
describe("K-N12-5: one ledger/erased across the workspace's projects", () => {
  let disk: DiskDb;
  afterEach(() => disk.dispose());

  it("erases a person's data from both projects' events in one event, and each project's step replay names that gap", async () => {
    disk = openDiskDb("sekhemet-workspace-erase-");
    const ws = realpathSync(disk.dir);
    const log = new EventLog(disk.db);
    const owner = log.localPrincipal();
    log.ensureLocalPerson({ name: "Ada" });
    const store = new CardStore(disk.db, log);
    const blobs = new BlobStore(ws);
    const root = (name: string): string => {
      mkdirSync(join(ws, name), { recursive: true });
      return realpathSync(join(ws, name));
    };
    const projects = [
      await store.ensureProject({ rootPath: root("a"), name: "A" }),
      await store.ensureProject({ rootPath: root("b"), name: "B" }),
    ];
    const notes: string[] = [];
    const packs: string[] = [];
    for (const [i, p] of projects.entries()) {
      const cardId = `card_${i}`;
      await store.createCard({ id: cardId, tier: "task", title: `T${i}`, projectId: p.id });
      const attempt = await store.runs.startAttempt({ cardId, attemptNumber: 1, modelId: "m" });
      const pack = blobs.put(JSON.stringify({ prompt: `Ada's phone, project ${p.name}` }));
      packs.push(pack);
      await store.runs.recordStep({
        attemptId: attempt.id,
        cardId,
        stepIndex: 1,
        calls: [],
        contextPackId: pack,
        promptTokens: 1,
        completionTokens: 1,
        durationMs: 1,
      });
      const note = await log.append({
        actor: "human",
        type: "card/note",
        cardId,
        payload: {},
        private: { text: `Ada's phone, project ${p.name}` },
      });
      notes.push(note.id);
    }
    const report = await log.erase({
      eventIds: notes,
      blobIds: packs,
      blobs,
      reason: "erasure",
      principal: owner,
    });
    expect(await log.getEventsByTypes(["ledger/erased"])).toHaveLength(1);
    expect(report.eventIds.sort()).toEqual([...notes].sort());
    for (const id of notes) expect(log.erasureOf(id)).toBe(report.erasedBySeq);
    expect(log.findPrivate("Ada's phone")).toEqual([]);
    // What a step replay reads (`step_replay.ts`): each project's pack is a named gap.
    const index = ledgerErasures(disk.db);
    const stepPacks = disk.db
      .prepare(
        "SELECT s.context_pack_id AS id, c.project_id AS project FROM steps s JOIN cards c ON c.id = s.card_id",
      )
      .all() as { id: string; project: string }[];
    expect(new Set(stepPacks.map((s) => s.project))).toEqual(new Set(projects.map((p) => p.id)));
    for (const s of stepPacks) {
      expect(blobs.get(s.id)).toBeUndefined();
      expect(index.byBlob.get(s.id)).toBe(report.erasedBySeq);
    }
    expect(log.verifyHashChainSync({ full: true }).valid).toBe(true);
  });
});
