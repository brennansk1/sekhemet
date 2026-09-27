import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveDepthProfile } from "../src/approvals.js";

// design-stage DS-P14-3: the planner plans and approves under the depth
// profile a person recorded on the ledger, read by the kernel's one function;
// internal tool only when none is recorded. A configured name still parses.

describe("DS-P14-3: resolveDepthProfile reads the recorded profile", () => {
  let dir: string;
  let db: DatabaseSync;
  let store: CardStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "planner-depth-"));
    db = new DatabaseSync(join(dir, "events.db"));
    initSchema(db);
    store = new CardStore(db, new EventLog(db));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is internal tool with none recorded, then the person's choice", async () => {
    expect(resolveDepthProfile({ store })).toBe("internal tool");
    await store.depthProfiles.choose({ profile: "prototype" }, "p_owner");
    expect(resolveDepthProfile({ store })).toBe("prototype");
    const project = await store.ensureProject({ rootPath: dir, name: "Shop" });
    expect(resolveDepthProfile({ store }, project.id)).toBe("prototype");
  });

  it("parses a configured name", () => {
    expect(resolveDepthProfile("internal-tool")).toBe("internal tool");
    expect(resolveDepthProfile("Production")).toBe("production");
  });
});
