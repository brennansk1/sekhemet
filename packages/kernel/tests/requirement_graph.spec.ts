import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardStore } from "../src/card_store.js";
import { EventLog } from "../src/log.js";
import { type DiskDb, openDiskDb } from "./support/disk_db.js";

// planner-pm P13 contract (B4.3 step 0): the requirement graph's records —
// requirements with dependencies, Kano class, must-have mark, criteria and
// slice (PM-P13-1); suspect links cleared only by a re-confirmation or an
// accepted change card (PM-P13-11, PM-P13-12); slices with an appetite,
// appetite reached, extended and requirements cut (PM-P13-9); a proposed
// release (PM-P13-13). Real SQLite files.

describe("the requirement graph (PM-P13-1, -11, -12)", () => {
  let disk: DiskDb;
  let log: EventLog;
  let store: CardStore;
  let projectId: string;
  beforeEach(async () => {
    disk = openDiskDb("sekhemet-req-graph-");
    log = new EventLog(disk.db);
    store = new CardStore(disk.db, log);
    projectId = (await store.ensureProject({ rootPath: disk.dir, name: "Shop" })).id;
  });
  afterEach(() => disk.dispose());

  it("PM-P13-1: a requirement carries dependencies, Kano class, must-have, criteria and slice; its text is private", async () => {
    const slice = await store.slices.create(
      { projectId: projectId, title: "Walking skeleton", appetite: { cards: 6, hours: 10 } },
      "p_owner",
    );
    expect(slice).toBe("SLICE-1");
    const load = await store.requirements.create(
      {
        title: "Load data",
        sliceId: slice,
        kano: "must-be",
        criteria: [{ id: "REQ-1.1", text: "Loads a 3-row CSV into 3 records" }],
      },
      "p_owner",
    );
    const show = await store.requirements.create(
      {
        title: "Show results",
        sliceId: slice,
        dependsOn: [load.id],
        kano: "performance",
        mustHave: false,
        criteria: [{ id: "REQ-2.1", text: "Shows 3 rows" }],
      },
      "p_owner",
    );
    const [created] = await log.getEventsByTypes(["requirement/created"]);
    expect(created?.payload).toEqual({
      id: "REQ-1",
      version: 1,
      projectId: projectId,
      sliceId: "SLICE-1",
      kano: "must-be",
      mustHave: true,
      criterionIds: ["REQ-1.1"],
    });
    expect(JSON.stringify(created?.payload)).not.toContain("CSV");

    const req = await store.requirements.get(show.id);
    expect(req).toMatchObject({
      id: "REQ-2",
      version: 1,
      projectId: projectId,
      sliceId: "SLICE-1",
      dependsOn: ["REQ-1"],
      kano: "performance",
      mustHave: false,
      cut: false,
      title: "Show results",
      criteria: [{ id: "REQ-2.1", text: "Shows 3 rows" }],
    });
    expect((await store.requirements.bySlice(slice)).map((r) => r.id)).toEqual(["REQ-1", "REQ-2"]);

    // Refused: an unknown dependency, an unknown slice, a duplicate criterion id.
    await expect(
      store.requirements.create({ title: "X", dependsOn: ["REQ-9"] }, "p_owner"),
    ).rejects.toThrow(/REQ-9/);
    await expect(
      store.requirements.create({ title: "X", sliceId: "SLICE-9" }, "p_owner"),
    ).rejects.toThrow(/SLICE-9/);
    await expect(
      store.requirements.create(
        {
          title: "X",
          criteria: [
            { id: "a", text: "1" },
            { id: "a", text: "2" },
          ],
        },
        "p_owner",
      ),
    ).rejects.toThrow(/criterion/);
    // A revision that would close a dependency cycle is refused.
    await expect(
      store.requirements.revise(load.id, { dependsOn: [show.id] }, "p_owner"),
    ).rejects.toThrow(/cycle/);

    // A revision carries forward what it does not restate.
    await store.requirements.revise(show.id, { mustHave: true }, "p_owner");
    expect(await store.requirements.get(show.id)).toMatchObject({
      version: 2,
      mustHave: true,
      kano: "performance",
      title: "Show results",
      dependsOn: ["REQ-1"],
    });
  });

  it("PM-P13-11, -12: earlier-version links go suspect until re-confirmed or a change card is accepted", async () => {
    await store.createCard({ id: "done1", tier: "task", title: "Old", status: "backlog" });
    await store.createCard({ id: "chg", tier: "task", title: "Change", status: "backlog" });
    const r = await store.requirements.create({ title: "Load data" }, "p_owner");
    await store.requirements.link({ requirementId: r.id, from: "card", ref: "done1" });
    await store.requirements.link({ requirementId: r.id, from: "test", ref: "t.ts > loads" });
    await store.requirements.revise(r.id, { title: "Load data from CSV" }, "p_owner");
    expect(store.requirements.links(r.id).every((l) => l.suspect)).toBe(true);

    // A change card for the suspect card, at the current version, clears it once accepted.
    await store.requirements.link({
      requirementId: r.id,
      from: "card",
      ref: "chg",
      changeFor: "done1",
    });
    const [changeLink] = (await log.getEventsByTypes(["trace/linked"])).slice(-1);
    expect(changeLink?.payload).toMatchObject({ ref: "chg", changeFor: "done1", version: 2 });
    expect(store.requirements.links(r.id).find((l) => l.ref === "done1")?.suspect).toBe(true);
    for (const to of ["ready", "in_progress", "verify", "review", "done"] as const) {
      await store.updateCardStatus("chg", to, "test", "human");
    }
    expect(store.requirements.links(r.id).find((l) => l.ref === "done1")?.suspect).toBe(false);
    // The test link stays suspect: nothing re-confirmed or changed it.
    expect(store.requirements.links(r.id).find((l) => l.from === "test")?.suspect).toBe(true);

    // Links with their flags, from the card side too.
    expect(store.requirements.linksFrom("card", "done1")).toEqual([
      { requirementId: r.id, from: "card", ref: "done1", version: 1, suspect: false },
    ]);
    // A later revision makes it suspect again: the change card stood on version 2.
    await store.requirements.revise(r.id, { title: "Load data from CSV or JSON" }, "p_owner");
    expect(store.requirements.links(r.id).find((l) => l.ref === "done1")?.suspect).toBe(true);
    await expect(
      store.requirements.link({ requirementId: r.id, from: "test", ref: "x", changeFor: "done1" }),
    ).rejects.toThrow(/change card/);
  });

  it("PM-P13-12: a change card resolves a suspect link only when accepted after the revision it answers", async () => {
    // "already" was done long before any of this — unrelated, earlier work.
    await store.createCard({ id: "already", tier: "task", title: "Older work", status: "backlog" });
    for (const to of ["ready", "in_progress", "verify", "review", "done"] as const) {
      await store.updateCardStatus("already", to, "test", "human");
    }
    await store.createCard({ id: "stale1", tier: "task", title: "Old", status: "backlog" });
    const r = await store.requirements.create({ title: "Load data" }, "p_owner");
    await store.requirements.link({ requirementId: r.id, from: "card", ref: "stale1" });
    await store.requirements.revise(r.id, { title: "Load data from CSV" }, "p_owner");
    expect(store.requirements.links(r.id).find((l) => l.ref === "stale1")?.suspect).toBe(true);

    // "already" is linked as the change card for "stale1" at the current
    // version, and its status is already "done" — but that acceptance
    // predates this revision by a wide margin: it proves nothing about the
    // revised requirement, so the suspect link must stay suspect.
    await store.requirements.link({
      requirementId: r.id,
      from: "card",
      ref: "already",
      changeFor: "stale1",
    });
    expect(store.requirements.links(r.id).find((l) => l.ref === "stale1")?.suspect).toBe(true);
  });

  it("PM-P13-3: unplanned must-haves are those with no card link from a card that is not rejected", async () => {
    const slice = await store.slices.create(
      { projectId: projectId, title: "S", appetite: { cards: 3 } },
      "p_owner",
    );
    const a = await store.requirements.create({ title: "A", sliceId: slice }, "p_owner");
    const b = await store.requirements.create({ title: "B", sliceId: slice }, "p_owner");
    await store.requirements.create({ title: "C", sliceId: slice, mustHave: false }, "p_owner");
    await store.createCard({ id: "c1", tier: "task", title: "c1", status: "backlog" });
    await store.createCard({ id: "c2", tier: "task", title: "c2", status: "backlog" });
    await store.requirements.link({ requirementId: a.id, from: "card", ref: "c1" });
    await store.requirements.link({ requirementId: b.id, from: "card", ref: "c2" });
    expect(await store.requirements.unplannedMustHaves({ sliceId: slice })).toEqual([]);
    await store.updateCardStatus("c2", "rejected", "won't do", "human");
    expect(
      (await store.requirements.unplannedMustHaves({ projectId: projectId })).map((r) => r.id),
    ).toEqual([b.id]);
  });
});

describe("slices, appetite and releases (PM-P13-9, PM-P13-13)", () => {
  let disk: DiskDb;
  let store: CardStore;
  let projectId: string;
  beforeEach(async () => {
    disk = openDiskDb("sekhemet-slices-");
    store = new CardStore(disk.db, new EventLog(disk.db));
    projectId = (await store.ensureProject({ rootPath: disk.dir, name: "Shop" })).id;
  });
  afterEach(() => disk.dispose());

  it("appetite reached, extended by a person, and nice-to-haves cut", async () => {
    await expect(
      store.slices.create({ projectId: projectId, title: "S", appetite: {} }, "p_owner"),
    ).rejects.toThrow(/appetite/);
    await expect(
      store.slices.create({ projectId: "nope", title: "S", appetite: { cards: 1 } }, "p_owner"),
    ).rejects.toThrow(/nope/);
    const s = await store.slices.create(
      { projectId: projectId, title: "Skeleton", appetite: { cards: 4, hours: 8 } },
      "p_owner",
    );
    const must = await store.requirements.create({ title: "M", sliceId: s }, "p_owner");
    const nice = await store.requirements.create(
      { title: "N", sliceId: s, mustHave: false },
      "p_owner",
    );

    await store.slices.recordAppetiteReached({ sliceId: s, cards: 4, hours: 6.5 });
    expect(await store.slices.get(s)).toMatchObject({
      id: s,
      projectId: projectId,
      title: "Skeleton",
      appetite: { cards: 4, hours: 8 },
      appetiteReached: true,
      extensions: 0,
      accepted: false,
      requirementIds: [must.id, nice.id],
      cutRequirementIds: [],
    });

    // Only a person extends, and only upward.
    await expect(
      store.slices.extend({ sliceId: s, appetite: { cards: 3 } }, "p_owner"),
    ).rejects.toThrow(/extend/);
    await store.slices.extend({ sliceId: s, appetite: { cards: 6 } }, "p_owner");
    expect(await store.slices.get(s)).toMatchObject({
      appetite: { cards: 6, hours: 8 },
      appetiteReached: false,
      extensions: 1,
    });

    // A must-have is never cut; a nice-to-have is, once.
    await expect(store.slices.cut({ requirementId: must.id }, "p_owner")).rejects.toThrow(
      /must-have/,
    );
    await store.slices.cut({ requirementId: nice.id, reason: "out of appetite" }, "p_owner");
    await expect(store.slices.cut({ requirementId: nice.id }, "p_owner")).rejects.toThrow(/cut/);
    expect((await store.requirements.get(nice.id))?.cut).toBe(true);
    expect((await store.slices.get(s))?.cutRequirementIds).toEqual([nice.id]);
    expect((await store.slices.list(projectId)).map((x) => x.id)).toEqual([s]);

    // State is read from the ledger: a second connection agrees.
    const db2 = new DatabaseSync(disk.path);
    const other = new CardStore(db2, new EventLog(db2));
    expect(await other.slices.get(s)).toEqual(await store.slices.get(s));
    db2.close();
  });

  it("PM-P13-13: a release is proposed only for a person-accepted slice, naming its proven requirements", async () => {
    const s = await store.slices.create(
      { projectId: projectId, title: "S", appetite: { cards: 2 } },
      "p_owner",
    );
    const a = await store.requirements.create(
      { title: "You can load a CSV", sliceId: s },
      "p_owner",
    );
    const other = await store.requirements.create({ title: "Elsewhere" }, "p_owner");
    const proposal = {
      sliceId: s,
      version: "0.2.0",
      requirementIds: [a.id],
      changelog: { Added: ["CSV import"] },
      notes: "You can now load a CSV.",
    };
    await expect(store.slices.proposeRelease(proposal)).rejects.toThrow(/accepted/);
    await store.recordSliceAccepted(
      { projectId: projectId, sliceId: s, completesProject: false },
      "human",
      { principal: "p_owner" },
    );
    await expect(
      store.slices.proposeRelease({ ...proposal, requirementIds: [other.id] }),
    ).rejects.toThrow(new RegExp(other.id));
    await expect(store.slices.proposeRelease({ ...proposal, version: "v1" })).rejects.toThrow(
      /version/,
    );
    await store.slices.proposeRelease(proposal);
    const [event] = await store.slices.releases(s);
    expect(event).toMatchObject({
      sliceId: s,
      projectId: projectId,
      version: "0.2.0",
      requirementIds: [a.id],
      changelog: { Added: ["CSV import"] },
      notes: "You can now load a CSV.",
    });
    const [raw] = await new EventLog(disk.db).getEventsByTypes(["release/proposed"]);
    expect(JSON.stringify(raw?.payload)).not.toContain("CSV");
    expect((await store.slices.get(s))?.accepted).toBe(true);
  });
});
