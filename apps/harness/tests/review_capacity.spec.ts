import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ConfigApiDeps, createConfigApi } from "../src/config_api.js";

// Dashboard NEW-dashboard-4 (DB-N4-1..3), the server half: Configuration's
// Review capacity and Project configuration over a real ledger, card store
// and board. The change is a person's, recorded with their principal; the
// In review limit it gives is recomputed for that project alone; a value of
// 0 or less changes nothing; who may not change it is told why.

// biome-ignore lint/suspicious/noExplicitAny: JSON read back from the API, checked field by field
type Json = any;

interface Fixture {
  dir: string;
  db: DatabaseSync;
  log: EventLog;
  cards: CardStore;
  board: BoardServiceImpl;
  server: Server;
  base: string;
  a: string;
  b: string;
}

let f: Fixture;
let may: { allowed: boolean; reason?: string } = { allowed: true };

async function setup(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "sek-review-capacity-"));
  mkdirSync(join(dir, ".sekhemet"), { recursive: true });
  const userConfig = join(dir, "user.toml");
  writeFileSync(userConfig, '[network]\nmode = "offline"\n');
  writeFileSync(
    join(dir, ".sekhemet", "config.toml"),
    '[machine]\nreserved_hours = "09:00-17:00"\n',
  );
  const db = new DatabaseSync(join(dir, "events.db"));
  initSchema(db);
  const log = new EventLog(db);
  const cards = new CardStore(db, log);
  const board = new BoardServiceImpl(cards);
  const a = (await cards.ensureProject({ rootPath: join(dir, "a"), name: "Atlas" })).id;
  const b = (await cards.ensureProject({ rootPath: join(dir, "b"), name: "Beacon" })).id;
  const deps: ConfigApiDeps = {
    repoPath: dir,
    log,
    json: (res, status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    },
    readJsonBody: async (req) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const t = Buffer.concat(chunks).toString("utf8");
      return t ? (JSON.parse(t) as Record<string, unknown>) : {};
    },
    isTrustedMutation: (req) => req.headers["x-sekhemet-action"] === "1",
    principalOf: () => "p_jane",
    userConfigPath: userConfig,
    env: {},
    cardStore: cards,
    reviewLimitFacts: (project) => board.reviewLimitFacts(project),
    mayChangeReviewCapacity: () => may,
  };
  const api = createConfigApi(deps);
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const [url = "/", search = ""] = (req.url ?? "/").split("?");
    if (!(await api.handle(req, res, url, new URLSearchParams(search)))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  f = { dir, db, log, cards, board, server, base, a, b };
}

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${f.base}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-sekhemet-action": "1" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as Record<string, Json> };
}

const reviewEvents = async () => f.log.getEventsByTypes(["project/review_hours"]);

beforeEach(async () => {
  may = { allowed: true };
  await setup();
});

afterEach(async () => {
  await new Promise<void>((r) => f.server.close(() => r()));
  f.db.close();
  rmSync(f.dir, { recursive: true, force: true });
});

describe("Review capacity (DB-N4-2)", () => {
  it("records the change with the person's principal and returns the recomputed limit at once", async () => {
    const before = await f.board.reviewLimitFacts(f.a);
    expect(before.limit).toBe(4); // 60 minutes a day at the 15-minute prior
    const r = await call("PUT", "/api/config/review", { project: f.a, minutesPerDay: 120 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ project: f.a, minutesPerDay: 120, reviewWip: 8 });
    const [e] = await reviewEvents();
    expect(e?.principal).toBe("p_jane");
    expect(e?.payload).toMatchObject({ id: f.a, reviewMinutesPerDay: 120 });
    expect((await f.board.reviewLimitFacts(f.a)).limit).toBe(8);
  });

  it("changes that project's limit only, never the other projects'", async () => {
    await call("PUT", "/api/config/review", { project: f.a, minutesPerDay: 120 });
    expect((await f.board.reviewLimitFacts(f.b)).limit).toBe(4);
    expect(f.cards.getProject(f.b)?.reviewMinutesPerDay).toBe(60);
  });

  it("GET names the project's minutes, its limit and that the person may change them", async () => {
    const r = await call("GET", `/api/config?project=${f.a}`);
    expect(r.status).toBe(200);
    expect(r.body.reviewCapacity).toEqual({
      project: f.a,
      minutesPerDay: 60,
      reviewWip: 4,
      allowed: true,
    });
  });

  it("a person without the permission is told why, and the change is refused", async () => {
    may = {
      allowed: false,
      reason:
        "You're a Member on Atlas. An Admin or a person this project's Accept rule names can change review capacity.",
    };
    const r = await call("GET", `/api/config?project=${f.a}`);
    expect(r.body.reviewCapacity).toMatchObject({ allowed: false, reason: may.reason });
    const put = await call("PUT", "/api/config/review", { project: f.a, minutesPerDay: 90 });
    expect(put.status).toBe(403);
    expect(put.body.error).toBe(may.reason);
    expect(await reviewEvents()).toHaveLength(0);
    expect(f.cards.getProject(f.a)?.reviewMinutesPerDay).toBe(60);
  });
});

describe("0 or less is refused (DB-N4-3, RG-S6-8)", () => {
  for (const bad of [0, -5, "abc", null]) {
    it(`refuses ${JSON.stringify(bad)}, keeps the previous value and leaves the limit unchanged`, async () => {
      await call("PUT", "/api/config/review", { project: f.a, minutesPerDay: 90 });
      const limit = (await f.board.reviewLimitFacts(f.a)).limit;
      const r = await call("PUT", "/api/config/review", { project: f.a, minutesPerDay: bad });
      expect(r.status).toBe(400);
      expect(r.body.key).toBe("review_minutes_per_day");
      expect(r.body.error).toBe("Review minutes per day must be more than 0.");
      expect(f.cards.getProject(f.a)?.reviewMinutesPerDay).toBe(90);
      expect((await f.board.reviewLimitFacts(f.a)).limit).toBe(limit);
      expect(await reviewEvents()).toHaveLength(1);
    });
  }
});

describe("Project configuration: each value's source (DB-N4-1)", () => {
  it("names the layer each effective value came from", async () => {
    const r = await call("GET", "/api/config");
    expect(r.body.sources).toMatchObject({
      "network.mode": "user",
      "machine.reserved_hours": "project",
    });
    // A key no file sets is the default's: absent from `sources`.
    expect(r.body.sources["review.review_minutes_per_day"]).toBeUndefined();
  });

  it("a refused value is the default's, not the file's that was refused", async () => {
    writeFileSync(
      join(f.dir, ".sekhemet", "config.toml"),
      "[review]\nreview_minutes_per_day = 0\n",
    );
    const r = await call("GET", "/api/config");
    expect(r.body.sources["review.review_minutes_per_day"]).toBeUndefined();
    expect(r.body.problems.join(" ")).toMatch(/review\.review_minutes_per_day/);
  });
});
