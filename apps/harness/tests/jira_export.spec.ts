import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importProposals, parseCsv } from "../src/import_board.js";
import { startDashboardServer } from "../src/server.js";

/**
 * NEW-integrations-5 (DEC-55): the Jira CSV export in Jira Cloud's columns —
 * `Issue Id` and `Parent` in place of the retired *Epic Link*, and each row's
 * issue type as the board shows it. Exported through the product's own
 * route (`GET /api/export?format=jira-csv`) over a real ledger on disk.
 */
describe("the Jira CSV export (NEW-integrations-5)", () => {
  let dir: string;
  let db: DatabaseSync;
  let cards: CardStore;
  let server: { port: number; close: () => Promise<void> };
  let base: string;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "jira-export-"));
    process.env.SEKHEMET_CONFIG_DIR = mkdtempSync(join(tmpdir(), "jira-export-cfg-"));
    db = new DatabaseSync(join(dir, "ledger.db"));
    initSchema(db);
    const log = new EventLog(db);
    cards = new CardStore(db, log);
    const epic = await cards.createCard({ tier: "epic", title: "Billing" });
    ids.epic = epic.id;
    ids.story = (
      await cards.createCard({ tier: "story", title: "Invoice totals", epicId: epic.id })
    ).id;
    ids.bug = (
      await cards.createCard({
        tier: "task",
        title: "Rounding error",
        change: "fix",
        epicId: epic.id,
      })
    ).id;
    ids.task = (
      await cards.createCard({ tier: "task", title: "Upgrade the ORM", change: "upgrade" })
    ).id;
    ids.spike = (
      await cards.createCard({ tier: "task", title: "Which PDF library", kind: "spike" })
    ).id;
    ids.subtask = (
      await cards.createCard({ tier: "task", title: "Totals in cents", parentId: ids.story })
    ).id;
    server = await startDashboardServer({
      db,
      log,
      boardService: new BoardServiceImpl(cards),
      cardStore: cards,
      repoPath: dir,
      port: 0,
      streamIntervalMs: 50,
      pressureLevel: () => 1,
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    await server.close();
    db.close();
    Reflect.deleteProperty(process.env, "SEKHEMET_CONFIG_DIR");
    rmSync(dir, { recursive: true, force: true });
  });

  const exported = async () => {
    const res = await fetch(`${base}/api/export?format=jira-csv`);
    expect(res.status).toBe(200);
    const body = await res.text();
    const [header, ...rows] = parseCsv(body);
    const at = (name: string) => (header ?? []).indexOf(name);
    return { body, header: header ?? [], rows, at };
  };

  it("INT-31, INT-45: Issue Id and Parent, and no Epic Link column", async () => {
    const { header, rows, at } = await exported();
    expect(header).toEqual([
      "Issue Id",
      "Parent",
      "Summary",
      "Issue Type",
      "Status",
      "Priority",
      "Story Points",
      "Sprint",
      "Labels",
      "Due Date",
      "Description",
    ]);
    expect(header).not.toContain("Epic Link");
    const issueIds = rows.map((r) => r[at("Issue Id")]);
    expect(new Set(issueIds).size).toBe(rows.length);
    const row = (id: string) => rows.find((r) => r[at("Issue Id")] === id) as string[];
    expect(row(ids.story as string)[at("Parent")]).toBe(ids.epic);
    expect(row(ids.bug as string)[at("Parent")]).toBe(ids.epic);
    expect(row(ids.subtask as string)[at("Parent")]).toBe(ids.story);
    expect(row(ids.epic as string)[at("Parent")]).toBe("");
    expect(row(ids.task as string)[at("Parent")]).toBe("");
    // Every Parent names a row of the same file.
    for (const r of rows) {
      const parent = r[at("Parent")];
      if (parent) expect(issueIds).toContain(parent);
    }
  });

  it("INT-46: each row's Issue Type is the type the board shows (a Bug is a Bug)", async () => {
    const { rows, at } = await exported();
    const type = (id: string) => rows.find((r) => r[at("Issue Id")] === id)?.[at("Issue Type")];
    expect(type(ids.epic as string)).toBe("Epic");
    expect(type(ids.story as string)).toBe("Story");
    expect(type(ids.bug as string)).toBe("Bug");
    expect(type(ids.task as string)).toBe("Task");
    expect(type(ids.spike as string)).toBe("Spike");
    // Jira takes a parent that is not an epic only for its own sub-task type.
    expect(type(ids.subtask as string)).toBe("Subtask");
  });

  it("INT-46a: imported back, each row is matched by its Issue Id and no card is proposed", async () => {
    const { body } = await exported();
    const board = await cards.listCards();
    const proposals = importProposals("jira-csv", body, board);
    expect(proposals.filter((p) => p.kind === "create_card")).toEqual([]);
    for (const p of proposals) {
      expect(p.kind).toBe("update_card");
      expect(p.patch?.externalRef).toMatchObject({ system: "jira", id: p.cardId });
    }
  });

  it("the Integrations page names the columns the export writes, and no Epic Link", async () => {
    const res = await fetch(`${base}/app/integrations.js`);
    expect(res.status).toBe(200);
    const page = await res.text();
    const jira = page.match(/id: "jira",[\s\S]*?does:\s*"([^"]+)"/)?.[1] ?? "";
    expect(jira).not.toContain("Epic Link");
    const { header } = await exported();
    for (const column of header) expect(jira, column).toContain(column);
  });
});
