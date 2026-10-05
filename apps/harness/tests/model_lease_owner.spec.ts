import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventLog, initSchema } from "@sekhemet/kernel";
import { modelLeaseOwner, setModelLeaseOwner } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import { ModelAccess } from "../src/model_access.js";

// MD-N17-1: the machine-wide model lease names the workspace of the process
// that holds it, by the id of the ledger its scheduler records on (rule 38a),
// so another project waiting for it can say whose it is.
describe("the model lease's owner", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
  });

  it("is the workspace whose ledger the scheduler records on", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sek-lease-owner-"));
    dirs.push(dir);
    const db = new DatabaseSync(join(dir, "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    await log.append({ actor: "human", type: "project/created", payload: {} });
    const id = log.workspaceId();
    expect(id).toMatch(/^ws_[0-9a-f]{12}$/);
    setModelLeaseOwner({ workspace: "before" });
    ModelAccess.forQueues([], { ledger: log, usableBytes: 24e9 });
    expect(modelLeaseOwner().workspace).toBe(id);
    setModelLeaseOwner({ workspace: "before" });
    ModelAccess.forQueues([], { usableBytes: 24e9 }).recordSwapsOn(log);
    expect(modelLeaseOwner().workspace).toBe(id);
    db.close();
  });

  // C4 gate: the process's shared scheduler keeps the first ledger it was
  // given; once that one is closed (a server stopped, a test's ledger), the
  // next caller's request failed with "database is not open". A closed
  // ledger names nobody, and the ledger the caller serves now names the owner.
  it("is named by the caller's ledger, and a closed one never fails the request", async () => {
    const open = async () => {
      const dir = mkdtempSync(join(tmpdir(), "sek-lease-owner-"));
      dirs.push(dir);
      const db = new DatabaseSync(join(dir, "events.db"));
      initSchema(db);
      const log = new EventLog(db);
      await log.append({ actor: "human", type: "project/created", payload: {} });
      return { db, log };
    };
    const first = await open();
    const access = ModelAccess.forQueues([], { usableBytes: 24e9 });
    access.recordSwapsOn(first.log);
    first.db.close();
    const second = await open();
    expect(() => access.recordSwapsOn(second.log)).not.toThrow();
    expect(modelLeaseOwner().workspace).toBe(second.log.workspaceId());
    second.db.close();
  });
});
