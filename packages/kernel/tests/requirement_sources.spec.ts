import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardStore } from "../src/card_store.js";
import { EventLog } from "../src/log.js";
import { type DiskDb, openDiskDb } from "./support/disk_db.js";

// design-stage P14 (DS-P14-5, -6, -7, -10): every requirement names its
// source; a candidate from a model or a comparable enters the graph only when
// a person accepts it, with a stable id at version 1; a walkthrough is
// recorded once per user role, each unsupported step becoming a candidate.
// Real SQLite files.

describe("requirement sources and candidates (DS-P14-5, -6, -7, -10)", () => {
  let disk: DiskDb;
  let log: EventLog;
  let store: CardStore;
  let projectId: string;
  beforeEach(async () => {
    disk = openDiskDb("sekhemet-candidates-");
    log = new EventLog(disk.db);
    store = new CardStore(disk.db, log);
    projectId = (await store.ensureProject({ rootPath: disk.dir, name: "Recipes" })).id;
  });
  afterEach(() => disk.dispose());

  it("a person's requirement is labelled person; the label is structural", async () => {
    const r = await store.requirements.create({ title: "Save favourites", projectId }, "p_owner");
    expect((await store.requirements.get(r.id))?.source).toBe("person");
  });

  it("DS-P14-6: a model's proposal is refused as a requirement until a person accepts the candidate", async () => {
    await expect(
      store.requirements.create(
        { title: "Export as PDF", projectId, source: "model-proposal" },
        "p_owner",
      ),
    ).rejects.toThrow(/candidate/);
    const id = await store.candidates.propose({
      projectId,
      source: "model-proposal",
      title: "Export as PDF",
      criteria: [{ id: "pdf.1", text: "A recipe exports to one page" }],
      kano: "attractive",
    });
    expect(id).toBe("CAND-1");
    const [proposed] = await log.getEventsByTypes(["requirement/proposed"]);
    expect(proposed?.payload).toEqual({
      candidateId: "CAND-1",
      source: "model-proposal",
      projectId,
      kano: "attractive",
      criterionIds: ["pdf.1"],
    });
    expect(proposed?.private).toMatchObject({ title: "Export as PDF" });
    // Not in the graph yet.
    expect(await store.requirements.list({ projectId })).toEqual([]);
    expect((await store.candidates.list({ projectId })).map((c) => c.state)).toEqual(["open"]);

    // DS-P14-10: accepted, it gets a stable id and version 1.
    await expect(store.candidates.accept(id, "")).rejects.toThrow(/person/);
    const accepted = await store.candidates.accept(id, "p_owner");
    expect(accepted).toEqual({ id: "REQ-1", version: 1 });
    const req = await store.requirements.get("REQ-1");
    expect(req).toMatchObject({
      source: "model-proposal",
      candidateId: "CAND-1",
      title: "Export as PDF",
      kano: "attractive",
      version: 1,
    });
    expect(await store.candidates.get(id)).toMatchObject({
      state: "accepted",
      requirementId: "REQ-1",
    });
    await expect(store.candidates.accept(id, "p_owner")).rejects.toThrow(/accepted/);
    // A rejected candidate cannot be accepted, and its reason is private.
    const other = await store.candidates.propose({
      projectId,
      source: "model-proposal",
      title: "Dark mode",
    });
    await store.candidates.reject(other, "p_owner", "Not this release");
    const [rejected] = await log.getEventsByTypes(["requirement/candidate_rejected"]);
    expect(rejected?.payload).toEqual({ candidateId: other });
    expect(rejected?.private).toEqual({ reason: "Not this release" });
    await expect(store.candidates.accept(other, "p_owner")).rejects.toThrow(/rejected/);
    // The id is never reused: the next requirement is REQ-2.
    expect((await store.requirements.create({ title: "Sign up", projectId }, "p_owner")).id).toBe(
      "REQ-2",
    );
  });

  it("DS-P14-5: a comparable cites its sources; a feature in at least half the comparables is must-be", async () => {
    await expect(
      store.candidates.propose({
        projectId,
        source: "comparable",
        title: "Shopping list",
        comparables: { foundIn: 3, of: 4 },
        sources: [],
      }),
    ).rejects.toThrow(/source/);
    const common = await store.candidates.propose({
      projectId,
      source: "comparable",
      title: "Shopping list",
      comparables: { foundIn: 3, of: 4 },
      sources: [
        { label: "Mealie", url: "https://github.com/mealie-recipes/mealie" },
        { label: "Tandoor", url: "https://github.com/TandoorRecipes/recipes" },
        { label: "Paprika" },
      ],
    });
    expect(await store.candidates.get(common)).toMatchObject({
      kano: "must-be",
      comparables: { foundIn: 3, of: 4 },
      sources: [{ label: "Mealie" }, { label: "Tandoor" }, { label: "Paprika" }],
    });
    const [event] = await log.getEventsByTypes(["requirement/proposed"]);
    expect(JSON.stringify(event?.payload)).not.toContain("github.com");
    await expect(
      store.candidates.propose({
        projectId,
        source: "comparable",
        title: "Meal planner",
        comparables: { foundIn: 2, of: 4 },
        kano: "attractive",
        sources: [{ label: "Mealie" }],
      }),
    ).rejects.toThrow(/must-be/);
    const rare = await store.candidates.propose({
      projectId,
      source: "comparable",
      title: "Nutrition facts",
      comparables: { foundIn: 1, of: 4 },
      sources: [{ label: "Paprika" }],
    });
    expect((await store.candidates.get(rare))?.kano).toBe("performance");
  });

  it("DS-P14-7: walks the story map once per role; each unsupported step becomes a candidate", async () => {
    const save = await store.requirements.create(
      { title: "Save favourites", projectId },
      "p_owner",
    );
    const walked = await store.candidates.recordWalkthrough({
      projectId,
      role: "Home cook",
      steps: [
        { id: "s1", text: "Finds a recipe", requirementIds: [] },
        { id: "s2", text: "Saves it", requirementIds: [save.id] },
        { id: "s3", text: "Gets the password back", requirementIds: [] },
      ],
    });
    expect(walked.candidateIds).toHaveLength(2);
    const [event] = await log.getEventsByTypes(["walkthrough/recorded"]);
    expect(event?.payload).toEqual({
      walkthroughId: walked.walkthroughId,
      projectId,
      steps: [
        { id: "s1", requirementIds: [] },
        { id: "s2", requirementIds: [save.id] },
        { id: "s3", requirementIds: [] },
      ],
    });
    expect(event?.private).toMatchObject({ role: "Home cook" });
    const candidates = await store.candidates.list({ projectId, state: "open" });
    expect(candidates.map((c) => [c.title, c.source, c.walkthrough?.stepId])).toEqual([
      ["Finds a recipe", "model-proposal", "s1"],
      ["Gets the password back", "model-proposal", "s3"],
    ]);
    expect((await store.candidates.walkthroughs(projectId)).map((w) => w.role)).toEqual([
      "Home cook",
    ]);
    // Once per named role.
    await expect(
      store.candidates.recordWalkthrough({
        projectId,
        role: " home cook ",
        steps: [{ id: "s1", text: "Finds a recipe", requirementIds: [] }],
      }),
    ).rejects.toThrow(/once per/);
    await expect(
      store.candidates.recordWalkthrough({
        projectId,
        role: "Guest",
        steps: [{ id: "s1", text: "Browses", requirementIds: ["REQ-99"] }],
      }),
    ).rejects.toThrow(/REQ-99/);
  });

  it("DS-P14-10: two accepts of one candidate at once create one requirement", async () => {
    const id = await store.candidates.propose({
      projectId,
      source: "model-proposal",
      title: "Export as PDF",
    });
    const other = await store.candidates.propose({
      projectId,
      source: "model-proposal",
      title: "Dark mode",
    });
    const out = await Promise.allSettled([
      store.candidates.accept(id, "p_owner"),
      store.candidates.accept(id, "p_other"),
      store.candidates.accept(other, "p_owner"),
    ]);
    expect(out.map((o) => o.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    const reqs = await store.requirements.list({ projectId });
    expect(reqs.map((r) => r.candidateId)).toEqual([id, other]);
    // Each got its own id.
    expect(new Set(reqs.map((r) => r.id)).size).toBe(2);
  });

  it("DS-P14-2: a checklist requirement enters only through a recorded depth-profile choice that marks its row", async () => {
    await expect(
      store.requirements.create(
        {
          title: "Recovers from a crash",
          projectId,
          source: "checklist",
          checklistRow: "reliability",
          invariant: "restarts",
        },
        "p_owner",
      ),
    ).rejects.toThrow(/depth profile/);
    expect(await store.requirements.list()).toEqual([]);
  });
});
