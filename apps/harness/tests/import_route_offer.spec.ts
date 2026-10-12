import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { toCsv } from "../src/integrations.js";
import { startDashboardServer } from "../src/server.js";
import { pageWriteHeaders } from "./page_headers.js";

/**
 * Loop waves 5–6 review (sweep 3, the Import sheet), through the route the
 * page calls: a file of more than 500 rows says which rows it offers and
 * which it does not (never a silent cut), and in a workspace of two projects
 * a new row's proposal names the project the page is on, so Apply creates
 * it there. A real SQLite ledger on disk and the real HTTP server.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanup.length) await (cleanup.pop() as () => Promise<void> | void)();
});

async function setup(projects: number) {
  const dir = mkdtempSync(join(tmpdir(), "import-offer-"));
  const cfg = mkdtempSync(join(tmpdir(), "import-offer-cfg-"));
  process.env.SEKHEMET_CONFIG_DIR = cfg;
  cleanup.push(() => {
    Reflect.deleteProperty(process.env, "SEKHEMET_CONFIG_DIR");
    rmSync(dir, { recursive: true, force: true });
    rmSync(cfg, { recursive: true, force: true });
  });
  const db = new DatabaseSync(join(dir, "ledger.db"));
  initSchema(db);
  const log = new EventLog(db);
  const cards = new CardStore(db, log);
  const ids: string[] = [];
  for (let i = 0; i < projects; i++) {
    const root = join(dir, `p${i}`);
    mkdirSync(root);
    ids.push((await cards.ensureProject({ name: `Project ${i}`, rootPath: root })).id);
  }
  const server = await startDashboardServer({
    db,
    log,
    boardService: new BoardServiceImpl(cards),
    cardStore: cards,
    repoPath: dir,
    port: 0,
    streamIntervalMs: 10_000,
    pressureLevel: () => 1,
  });
  cleanup.push(async () => {
    await server.close();
    db.close();
  });
  const base = `http://127.0.0.1:${server.port}`;
  const post = async (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await pageWriteHeaders(base)) },
      body: JSON.stringify(body),
    });
  return { cards, ids, post };
}

describe("an import over 500 rows names the cut (W6 review)", () => {
  it("offers the first 500, says so in a note, and its count is what is offered", async () => {
    const s = await setup(1);
    const rows = Array.from({ length: 503 }, (_, i) => [`Row ${i + 1}`]);
    const res = await s.post("/api/import", {
      format: "linear-csv",
      content: toCsv([["Title"], ...rows]),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { proposals: unknown[]; notes: string[] };
    expect(body.proposals).toHaveLength(500);
    expect(body.notes.join("\n")).toMatch(
      /Only the first 500 of 503 are proposed; import the other 3 in a second file\./,
    );
  });
});

describe("an import in a workspace of two projects lands in the page's project (W6 review)", () => {
  it("a new row applies into the project the request names", async () => {
    const s = await setup(2);
    const res = await s.post("/api/import", {
      format: "linear-csv",
      content: toCsv([["Title"], ["Brand new row"]]),
      projectId: s.ids[1],
    });
    expect(res.status).toBe(200);
    const { proposals } = (await res.json()) as { proposals: { id: string }[] };
    expect(proposals).toHaveLength(1);
    const applied = await s.post(`/api/pm/proposals/${proposals[0]?.id}/apply`, {});
    expect(applied.status, await applied.clone().text()).toBe(200);
    const made = (await s.cards.listCards()).find((c) => c.title === "Brand new row");
    expect(made?.projectId).toBe(s.ids[1]);
  });

  it("a project that does not exist is refused, and nothing is proposed", async () => {
    const s = await setup(2);
    const res = await s.post("/api/import", {
      format: "linear-csv",
      content: toCsv([["Title"], ["Brand new row"]]),
      projectId: "proj_missing",
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toMatch(/No project/);
  });
});
