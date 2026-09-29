import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { loadCalibrationLog } from "@sekhemet/planner";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startDashboardServer } from "../src/server.js";
import { type Kernel, runWave2Command } from "../src/wave2.js";
import { pageWriteHeaders } from "./page_headers.js";

/**
 * P15: a logged assumption is only half the loop. Until a person's verdict on
 * it is recorded, the override rate is zero for every category and the
 * assume-to-ask shift can never fire, so the planner keeps assuming in a
 * category the human corrects every time.
 */
describe("recording the outcome of a logged assumption (P15)", () => {
  let repo: string;
  let db: DatabaseSync;
  let log: EventLog;
  let cardStore: CardStore;
  let k: Kernel;

  const logAssumption = (id: string, cardId: string) =>
    log.append({
      actor: "planner",
      type: "assumption/logged",
      cardId,
      payload: {
        id,
        cardId,
        category: "data_format",
        statement: "Timestamps are ISO 8601 in UTC",
        basis: "every other route in this repo does",
        excerpt: "record the time",
        createdAt: new Date().toISOString(),
      },
    });

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), "assumptions-"));
    db = new DatabaseSync(join(repo, "events.db"));
    initSchema(db);
    log = new EventLog(db);
    cardStore = new CardStore(db, log);
    await cardStore.createCard({ id: "card_t", tier: "story", title: "Timestamps" });
    k = { repoPath: repo, cardStore, log };
  });
  afterEach(() => {
    db.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it("records a verdict from the CLI and moves the category's override rate", async () => {
    await logAssumption("asm_aaaaaaaaaa", "card_t");
    await logAssumption("asm_bbbbbbbbbb", "card_t");
    const lines: string[] = [];
    const io = { print: (l: string) => lines.push(l) };

    expect(await runWave2Command("assume", [], k, io)).toBe(0);
    expect(lines.join("\n")).toContain("asm_aaaaaaaaaa");

    expect(await runWave2Command("assume", ["keep", "asm_aaaaaaaaaa"], k, io)).toBe(0);
    expect(
      await runWave2Command(
        "assume",
        ["override", "asm_bbbbbbbbbb", "--answer", "epoch millis, not ISO"],
        k,
        io,
      ),
    ).toBe(0);

    const calibration = (await loadCalibrationLog({ store: cardStore, log })).calibrationFor(
      "data_format",
    );
    expect(calibration).toMatchObject({ observed: 2, overridden: 1 });
    // The human's answer is kept with the verdict, not thrown away.
    const [, override] = await log.getEventsByTypes(["assumption/outcome"]);
    expect((override?.payload as { humanAnswer?: string }).humanAnswer).toBe(
      "epoch millis, not ISO",
    );

    expect(await runWave2Command("assume", ["keep", "asm_nope"], k, io)).toBe(1);
    expect(await runWave2Command("assume", ["shrug", "asm_aaaaaaaaaa"], k, io)).toBe(1);
  });

  it("records a verdict over REST, and refuses an outcome it does not understand", async () => {
    await logAssumption("asm_cccccccccc", "card_t");
    const server = await startDashboardServer({
      db,
      log,
      cardStore,
      boardService: new BoardServiceImpl(cardStore),
      repoPath: repo,
      port: 0,
    });
    const base = `http://127.0.0.1:${server.port}`;
    const post = async (path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(await pageWriteHeaders(base)) },
        body: JSON.stringify(body),
      });

    try {
      const listed = (await (await fetch(`${base}/api/assumptions`)).json()) as {
        assumptions: { id: string }[];
      };
      expect(listed.assumptions.map((a) => a.id)).toEqual(["asm_cccccccccc"]);

      expect((await post("/api/assumptions/asm_cccccccccc", { outcome: "maybe" })).status).toBe(
        400,
      );
      expect((await post("/api/assumptions/asm_dddddddddd", { outcome: "kept" })).status).toBe(404);

      const res = await post("/api/assumptions/asm_cccccccccc", { outcome: "overridden" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { recorded: { overridden: boolean } };
      expect(body.recorded.overridden).toBe(true);

      // The route wrote what the planner reads back, not a parallel store.
      expect(
        (await loadCalibrationLog({ store: cardStore, log })).calibrationFor("data_format"),
      ).toMatchObject({ observed: 1, overridden: 1 });
    } finally {
      await server.close();
    }
  });
});
