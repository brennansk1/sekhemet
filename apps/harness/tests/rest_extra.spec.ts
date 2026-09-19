import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDashboardServer } from "../src/server.js";

describe("REST API completeness (H12)", () => {
  let server: { port: number; close: () => Promise<void> };
  let cards: CardStore;
  let base: string;
  let projectId: string;
  const repo = mkdtempSync(join(tmpdir(), "rest-"));
  const post = (path: string, body: unknown, trusted = true) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(trusted ? { "X-Sekhemet-Action": "1" } : {}) },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    process.env.SEKHEMET_CONFIG_DIR = mkdtempSync(join(tmpdir(), "rest-cfg-"));
    // `run` and `calibrate` start a CLI process; here a script that exits at once.
    const fakeCli = join(repo, "fake-cli.mjs");
    writeFileSync(fakeCli, "process.exit(0);\n");
    process.env.SEKHEMET_CLI = fakeCli;
    mkdirSync(join(repo, ".sekhemet", "evidence"), { recursive: true });
    writeFileSync(
      join(repo, ".sekhemet", "gates.toml"),
      '[[gate]]\nid = "ok"\nrung = "test"\ncommand = "node"\nargs = ["-e", "process.exit(0)"]\n',
    );
    writeFileSync(join(repo, ".sekhemet", "evidence", "latest-card_big.json"), JSON.stringify({ id: "ev_1", passed: false }));
    const db = new DatabaseSync(":memory:");
    initSchema(db);
    const log = new EventLog(db);
    cards = new CardStore(db, log);
    projectId = (await cards.ensureProject({ name: "Chronicle", rootPath: repo })).id;
    await cards.createCard({ id: "card_big", tier: "story", title: "Too big", status: "ready" });
    server = await startDashboardServer({ db, log, cardStore: cards, boardService: new BoardServiceImpl(cards), repoPath: repo, port: 0 });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(async () => {
    delete process.env.SEKHEMET_CLI;
    await server.close();
  });

  it("serves the workspace and a project's board", async () => {
    const ws = (await (await fetch(`${base}/api/workspace`)).json()) as { workspace: { repoPath: string }; projects: { id: string }[] };
    expect(ws.workspace.repoPath).toBe(repo);
    expect(ws.projects.map((p) => p.id)).toContain(projectId);
    const board = (await (await fetch(`${base}/api/projects/${projectId}/board`)).json()) as { board: { projectId: string } };
    expect(board.board.projectId).toBe(projectId);
  });

  it("creates a card in a project, refusing untrusted writes and missing titles", async () => {
    expect((await post(`/api/projects/${projectId}/cards`, { title: "x" }, false)).status).toBe(403);
    expect((await post(`/api/projects/${projectId}/cards`, { tier: "task" })).status).toBe(400);
    const res = await post(`/api/projects/${projectId}/cards`, { title: "Add the verifier", tier: "task", priority: 2, spec: "Detect tampering" });
    expect(res.status).toBe(201);
    const { card } = (await res.json()) as { card: { id: string; projectId?: string; status: string } };
    expect(card.status).toBe("backlog");
    expect((await cards.getCard(card.id))?.priority).toBe(2);
  });

  it("splits a card into ordered parts and parks the original", async () => {
    expect((await post("/api/cards/card_big/split", { parts: [{ title: "only one" }] })).status).toBe(400);
    const res = await post("/api/cards/card_big/split", { parts: [{ title: "Read routes" }, { title: "Write route", spec: "POST /events" }] });
    expect(res.status).toBe(200);
    const { subtasks } = (await res.json()) as { subtasks: { id: string; title: string; dependsOn?: string[] }[] };
    expect(subtasks.map((s) => s.title)).toEqual(["Read routes", "Write route"]);
    expect(subtasks[1]?.dependsOn).toContain(subtasks[0]?.id);
    expect((await cards.getCard("card_big"))?.status).toBe("parked");
  });

  it("runs gates in the repository, serves evidence, and starts runs and calibration in the background", async () => {
    const gate = (await (await post("/api/cards/card_big/gate", {})).json()) as { passed: boolean; cwd: string };
    expect(gate).toMatchObject({ passed: true, cwd: repo });
    const ev = (await (await fetch(`${base}/api/cards/card_big/evidence`)).json()) as { evidence: { id: string } };
    expect(ev.evidence.id).toBe("ev_1");
    expect((await fetch(`${base}/api/cards/card_none/evidence`)).status).toBe(404);
    const run = await post("/api/cards/card_big/run", {});
    expect(run.status).toBe(202);
    expect(((await run.json()) as { pid: number }).pid).toBeGreaterThan(0);
    const cal = await post("/api/machine/calibrate", {});
    expect(cal.status).toBe(202);
  });
});
