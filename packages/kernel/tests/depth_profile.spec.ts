import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardStore } from "../src/card_store.js";
import {
  DEFAULT_DEPTH_PROFILE,
  DEPTH_PROFILE_SELECTS,
  QUALITY_CHECKLIST,
  checklistRowsFor,
  depthProfileOf,
  parseDepthProfile,
} from "../src/depth_profile.js";
import { EventLog } from "../src/log.js";
import { type DiskDb, openDiskDb } from "./support/disk_db.js";

// design-stage P14 (DS-P14-1, -2, -3): the project's depth profile, chosen by
// a person with a principal and read by one function; each quality-checklist
// row the profile marks must-have becomes a requirement. Real SQLite files.

const text = (row: string) => ({
  title: `Quality: ${row}`,
  criteria: [{ id: `${row}.1`, text: `The ${row} check holds` }],
});

describe("the depth profile (DS-P14-1, -2, -3)", () => {
  let disk: DiskDb;
  let log: EventLog;
  let store: CardStore;
  let projectId: string;
  beforeEach(async () => {
    disk = openDiskDb("sekhemet-depth-");
    log = new EventLog(disk.db);
    store = new CardStore(disk.db, log);
    projectId = (await store.ensureProject({ rootPath: disk.dir, name: "Billing" })).id;
  });
  afterEach(() => disk.dispose());

  it("reads internal tool, unrecorded, only when no profile was chosen", () => {
    expect(DEFAULT_DEPTH_PROFILE).toBe("internal tool");
    expect(depthProfileOf(undefined)).toMatchObject({
      profile: "internal tool",
      recorded: false,
    });
    expect(depthProfileOf(disk.db, projectId)).toMatchObject({
      profile: "internal tool",
      recorded: false,
      approval: "criteria",
      strength: "blocking",
    });
    expect(store.depthProfiles.of(projectId).recorded).toBe(false);
  });

  it("DS-P14-1, -3: records the person's choice with the proposal, the approval level and strength rule it selects", async () => {
    const rows = checklistRowsFor("production");
    const checklist = Object.fromEntries(rows.map((r) => [r, text(r)]));
    const chosen = await store.depthProfiles.choose(
      {
        profile: "production",
        projectId,
        proposed: "production",
        reason: "It takes payments",
        checklist,
      },
      "p_owner",
    );
    expect(chosen.record).toMatchObject({
      profile: "production",
      recorded: true,
      projectId,
      proposed: "production",
      approval: "must_have_examples",
      strength: "blocking",
      principal: "p_owner",
    });
    const [event] = await log.getEventsByTypes(["project/depth_profile_chosen"]);
    expect(event?.payload).toEqual({
      profile: "production",
      projectId,
      proposed: "production",
      approval: "must_have_examples",
      strength: "blocking",
    });
    expect(event?.private).toEqual({ reason: "It takes payments" });
    expect(event?.principal).toBe("p_owner");
    // The one reader, from any connection to the file.
    expect(depthProfileOf(disk.db, projectId).profile).toBe("production");
    expect(store.depthProfiles.of(projectId).seq).toBe(event?.seq);
    // Another project with none recorded still reads the default.
    const other = (await store.ensureProject({ rootPath: `${disk.dir}/docs`, name: "Docs" })).id;
    expect(depthProfileOf(disk.db, other)).toMatchObject({
      profile: "internal tool",
      recorded: false,
    });
  });

  it("DS-P14-1: refuses a choice with no person, or an unknown profile, and appends nothing", async () => {
    await expect(
      store.depthProfiles.choose({ profile: "prototype", projectId }, ""),
    ).rejects.toThrow(/person/);
    await expect(
      store.depthProfiles.choose({ profile: "enterprise" as never, projectId }, "p_owner"),
    ).rejects.toThrow(/prototype, internal tool, production, regulated/);
    expect(await log.getEventsByTypes(["project/depth_profile_chosen"])).toEqual([]);
  });

  it("a profile chosen for the repository applies to a project with none of its own; a project's own wins", async () => {
    await store.depthProfiles.choose({ profile: "prototype" }, "p_owner");
    expect(depthProfileOf(disk.db, projectId).profile).toBe("prototype");
    expect(depthProfileOf(disk.db).profile).toBe("prototype");
    await store.depthProfiles.choose(
      {
        profile: "regulated",
        projectId,
        checklist: Object.fromEntries(checklistRowsFor("regulated").map((r) => [r, text(r)])),
      },
      "p_owner",
    );
    expect(depthProfileOf(disk.db, projectId).profile).toBe("regulated");
    expect(depthProfileOf(disk.db).profile).toBe("prototype");
  });

  it("DS-P14-2: adds one requirement per must-have checklist row, each with a criterion or an invariant; a prototype adds none", async () => {
    expect(checklistRowsFor("prototype")).toEqual([]);
    expect(checklistRowsFor("internal tool").length).toBeGreaterThan(0);
    expect(checklistRowsFor("regulated")).toEqual(QUALITY_CHECKLIST.map((r) => r.row));
    const proto = await store.depthProfiles.choose({ profile: "prototype", projectId }, "p_owner");
    expect(proto.checklistRequirementIds).toEqual([]);
    expect(await store.requirements.list({ projectId })).toEqual([]);

    const rows = checklistRowsFor("internal tool");
    // A row with neither a criterion nor an invariant is refused, before anything is appended.
    const missing = Object.fromEntries(rows.map((r) => [r, { title: `Quality: ${r}` }]));
    await expect(
      store.depthProfiles.choose(
        { profile: "internal tool", projectId, checklist: missing },
        "p_owner",
      ),
    ).rejects.toThrow(/criterion or a project-gate invariant/);
    await expect(
      store.depthProfiles.choose({ profile: "internal tool", projectId }, "p_owner"),
    ).rejects.toThrow(new RegExp(rows[0] as string));
    expect(depthProfileOf(disk.db, projectId).profile).toBe("prototype");

    const [first, ...rest] = rows;
    const checklist = {
      ...Object.fromEntries(rest.map((r) => [r, text(r)])),
      [first as string]: { title: "Every request is logged", invariant: "audit-log" },
    };
    const chosen = await store.depthProfiles.choose(
      { profile: "internal tool", projectId, checklist },
      "p_owner",
    );
    expect(chosen.checklistRequirementIds).toHaveLength(rows.length);
    const reqs = await store.requirements.list({ projectId });
    expect(reqs.map((r) => r.checklistRow)).toEqual(rows);
    expect(reqs.every((r) => r.source === "checklist" && r.mustHave)).toBe(true);
    expect(reqs[0]).toMatchObject({ invariant: "audit-log", criteria: [] });
    const [created] = await log.getEventsByTypes(["requirement/created"]);
    expect(created?.payload).toMatchObject({ source: "checklist", checklistRow: first });
    expect(JSON.stringify(created?.payload)).not.toContain("logged");

    // Choosing a deeper profile adds only the rows not yet present.
    const deeper = checklistRowsFor("production").filter((r) => !rows.includes(r));
    const again = await store.depthProfiles.choose(
      {
        profile: "production",
        projectId,
        checklist: Object.fromEntries(deeper.map((r) => [r, text(r)])),
      },
      "p_owner",
    );
    expect(again.checklistRequirementIds).toHaveLength(deeper.length);
    expect(
      (await store.requirements.list({ projectId })).filter((r) => r.source === "checklist"),
    ).toHaveLength(rows.length + deeper.length);
  });

  it("names the profiles and what each selects, and parses a configured name", () => {
    expect(DEPTH_PROFILE_SELECTS).toEqual({
      prototype: { approval: "criteria", strength: "advisory" },
      "internal tool": { approval: "criteria", strength: "blocking" },
      production: { approval: "must_have_examples", strength: "blocking" },
      regulated: { approval: "every_file", strength: "blocking" },
    });
    expect(parseDepthProfile(" Internal-Tool ")).toBe("internal tool");
    expect(parseDepthProfile("internal_tool")).toBe("internal tool");
    expect(parseDepthProfile("REGULATED")).toBe("regulated");
    expect(parseDepthProfile("enterprise")).toBeUndefined();
  });
});
