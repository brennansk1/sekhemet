import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardStore } from "../src/card_store.js";
import { EventLog } from "../src/log.js";
import { generatedHeader, readGeneratedHeader } from "../src/project_documents.js";
import { type DiskDb, openDiskDb } from "./support/disk_db.js";

// design-stage NEW-design-stage-3 (DS-N3-1, -2, -3, -5, -7): the record of
// each export — path, SHA-256, the ledger seq in the generated header — and of
// each import diff, one proposal per difference that changes nothing until a
// person applies it. Real SQLite files.

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe("project documents (DS-N3-1, -2, -3, -5, -7)", () => {
  let disk: DiskDb;
  let log: EventLog;
  let store: CardStore;
  beforeEach(async () => {
    disk = openDiskDb("sekhemet-docs-");
    log = new EventLog(disk.db);
    store = new CardStore(disk.db, log);
    await store.requirements.create({ title: "Save favourites" }, "p_owner");
  });
  afterEach(() => disk.dispose());

  it("DS-N3-1: the generated header names the ledger seq, and reads back", () => {
    const header = generatedHeader(42);
    expect(header).toMatch(/^<!-- /);
    expect(readGeneratedHeader(`${header}\n# Brief\n`)).toBe(42);
    expect(readGeneratedHeader("# A person's own brief\n")).toBeUndefined();
  });

  it("DS-N3-1, -3: records each export's path, SHA-256 and kind at the seq it was generated from", async () => {
    const seq = (await log.getEventsByTypes(["requirement/created"]))[0]?.seq as number;
    const brief = `${generatedHeader(seq)}\n# Brief\n`;
    await store.documents.recordExport({
      seq,
      noNames: true,
      files: [
        { path: "docs/product/brief.md", sha256: sha(brief), kind: "brief" },
        { path: "docs/decisions/0001-use-sqlite.md", sha256: sha("x"), kind: "decision" },
      ],
    });
    const [event] = await log.getEventsByTypes(["docs/exported"]);
    expect(event?.payload).toEqual({
      seq,
      noNames: true,
      files: [
        { path: "docs/product/brief.md", sha256: sha(brief), kind: "brief" },
        { path: "docs/decisions/0001-use-sqlite.md", sha256: sha("x"), kind: "decision" },
      ],
    });
    expect(store.documents.lastExport("docs/product/brief.md")).toMatchObject({
      sha256: sha(brief),
      seq,
      kind: "brief",
    });
    // A seq the ledger has not reached, an escaping path, a README: refused.
    await expect(
      store.documents.recordExport({ seq: seq + 1000, noNames: false, files: [] }),
    ).rejects.toThrow(/seq/);
    await expect(
      store.documents.recordExport({
        seq,
        noNames: false,
        files: [{ path: "../outside.md", sha256: sha("x"), kind: "brief" }],
      }),
    ).rejects.toThrow(/inside the repository/);
    await expect(
      store.documents.recordExport({
        seq,
        noNames: false,
        files: [{ path: "README.md", sha256: sha("x"), kind: "brief" }],
      }),
    ).rejects.toThrow(/README.md/);
  });

  it("DS-N3-2, -5: an import diff is one proposal per difference; nothing changes until a person applies one", async () => {
    const seq = (await log.getEventsByTypes(["requirement/created"]))[0]?.seq as number;
    const edited = `${generatedHeader(seq)}\n# Requirements\n- REQ-1 Save and share favourites\n`;
    await expect(
      store.documents.recordImportDiff({
        path: "docs/product/requirements.md",
        commit: "0123456789abcdef0123456789abcdef01234567",
        text: edited,
        differences: [],
      }),
    ).rejects.toThrow(/exported/);
    await store.documents.recordExport({
      seq,
      noNames: false,
      files: [
        { path: "docs/product/requirements.md", sha256: sha("before"), kind: "requirements" },
      ],
    });
    const ids = await store.documents.recordImportDiff({
      path: "docs/product/requirements.md",
      commit: "0123456789abcdef0123456789abcdef01234567",
      text: edited,
      differences: [
        {
          kind: "changed",
          target: "requirement",
          targetId: "REQ-1",
          field: "title",
          proposed: "Save and share favourites",
        },
        { kind: "added", target: "requirement", proposed: "Print a recipe" },
      ],
    });
    expect(ids).toEqual(["DOCP-1", "DOCP-2"]);
    const [event] = await log.getEventsByTypes(["docs/import_diffed"]);
    expect(event?.payload).toMatchObject({
      path: "docs/product/requirements.md",
      sha256: sha(edited),
      headerSeq: seq,
      proposals: [
        { id: "DOCP-1", kind: "changed", target: "requirement", targetId: "REQ-1", field: "title" },
        { id: "DOCP-2", kind: "added", target: "requirement" },
      ],
    });
    expect(JSON.stringify(event?.payload)).not.toContain("Print a recipe");
    // The ledger is unchanged: the requirement is still at version 1.
    expect((await store.requirements.get("REQ-1"))?.version).toBe(1);
    expect((await store.documents.openProposals()).map((p) => [p.id, p.proposed])).toEqual([
      ["DOCP-1", "Save and share favourites"],
      ["DOCP-2", "Print a recipe"],
    ]);
    await expect(store.documents.applyProposal("DOCP-1", "")).rejects.toThrow(/person/);
    await store.documents.applyProposal("DOCP-1", "p_owner");
    await store.documents.dismissProposal("DOCP-2", "p_owner");
    expect(await store.documents.openProposals()).toEqual([]);
    await expect(store.documents.applyProposal("DOCP-1", "p_owner")).rejects.toThrow(/already/);

    // DS-N3-5: a file without the generated header is offered as proposals too, marked so.
    await store.documents.recordExport({
      seq,
      noNames: false,
      files: [{ path: "docs/product/brief.md", sha256: sha("b"), kind: "brief" }],
    });
    await store.documents.recordImportDiff({
      path: "docs/product/brief.md",
      commit: "0123456789abcdef0123456789abcdef01234567",
      text: "# My own brief\n",
      differences: [{ kind: "changed", target: "brief", field: "problem", proposed: "Mine" }],
    });
    const events = await log.getEventsByTypes(["docs/import_diffed"]);
    expect(events[1]?.payload).not.toHaveProperty("headerSeq");
  });
});
