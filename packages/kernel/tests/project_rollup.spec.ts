import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardStore } from "../src/card_store.js";
import { EventLog } from "../src/log.js";
import { type DiskDb, openDiskDb } from "./support/disk_db.js";

// kernel.md rule 30 and NEW-kernel-5: a project's status is derived from its
// top-level cards (active or idle, never done), and `done` only by a person's
// `slice/accepted` of the completing slice (K-N5-3, K-N5-5). Real SQLite.

describe("the project rollup (K-N5-3, K-N5-5)", () => {
  let disk: DiskDb;
  let log: EventLog;
  let store: CardStore;
  let projectId: string;
  beforeEach(async () => {
    disk = openDiskDb("sekhemet-rollup-");
    log = new EventLog(disk.db);
    store = new CardStore(disk.db, log);
    projectId = (await store.ensureProject({ rootPath: disk.dir, name: "P" })).id;
  });
  afterEach(() => disk.dispose());

  const setStatus = async (id: string, to: "done" | "rejected" | "ready") =>
    store.updateCardStatus(id, to, undefined, "human", { override: true });

  it("K-N5-3: idle with no open top-level card, active with one; paused and archived take precedence", async () => {
    expect(await store.projectRollup(projectId)).toBe("idle");
    await store.createCard({ id: "a", tier: "story", title: "A", projectId });
    await store.createCard({ id: "a1", tier: "task", title: "A1", parentId: "a", projectId });
    expect(await store.projectRollup(projectId)).toBe("active");
    await setStatus("a", "done");
    // Only top-level cards count: an open child does not make the project active.
    expect(await store.projectRollup(projectId)).toBe("idle");
    // Every top-level card done and no slice accepted: idle, never done.
    await store.setProjectStatus(projectId, "paused");
    expect(await store.projectRollup(projectId)).toBe("paused");
    await store.setProjectStatus(projectId, "archived");
    expect(await store.projectRollup(projectId)).toBe("archived");
  });

  it("K-N5-5: done only from a person's slice/accepted completing the project; a new card reopens it", async () => {
    await store.createCard({ id: "a", tier: "story", title: "A", projectId });
    await setStatus("a", "done");
    await expect(store.setProjectStatus(projectId, "done" as never)).rejects.toThrow(
      /slice\/accepted/,
    );
    await expect(
      store.recordSliceAccepted({ projectId, sliceId: "s1", completesProject: true }, "planner"),
    ).rejects.toThrow(/person/);
    await store.recordSliceAccepted(
      { projectId, sliceId: "s0", completesProject: false },
      "human",
      {
        principal: "p_owner",
      },
    );
    expect(await store.projectRollup(projectId)).toBe("idle");
    await store.recordSliceAccepted({ projectId, sliceId: "s1", completesProject: true }, "human", {
      principal: "p_owner",
    });
    expect(await store.projectRollup(projectId)).toBe("done");
    const [accepted] = (await log.getEventsByTypes(["slice/accepted"])).slice(-1);
    expect(accepted?.principal).toBe("p_owner");

    await store.createCard({ id: "b", tier: "story", title: "B", projectId });
    expect(await store.projectRollup(projectId)).toBe("active");
    await setStatus("b", "done");
    // The earlier acceptance does not cover a card opened after it.
    expect(await store.projectRollup(projectId)).toBe("idle");
  });
});
