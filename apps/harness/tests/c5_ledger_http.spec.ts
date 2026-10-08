import { spawn } from "node:child_process";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore } from "@sekhemet/kernel";
import { describe, expect, it } from "vitest";
import { openLocalLedger } from "../src/ledger_cmds.js";
import { startDashboardServer } from "../src/server.js";
import { freePort, place, spawnCli } from "./support/cli_spawn.js";
import { startEngine } from "./support/g4_engine.js";
import { queueProject, runQueueOn } from "./support/g4_queue.js";
import { g6Repo } from "./support/g6_review.js";

/**
 * The ledger's health at the doors (C5; C2d G1 #4, RUN-72, the traces store):
 * a real dashboard server (`startDashboardServer`) over a real ledger, the
 * file edited through a second SQLite connection while the server runs, as a
 * person with `sqlite3` would; a Team `sekhemet serve` spawned as the built
 * binary (`apps/harness/dist/index.js`) for the health route; and
 * `sekhemet queue` spawned while another process holds `traces.db`.
 */

/** Drop the append-only triggers, then run `statement`: a hand edit of the file. */
function tamper(file: string, statement: string): void {
  const db = new DatabaseSync(file);
  try {
    db.exec(
      "DROP TRIGGER IF EXISTS events_no_update; DROP TRIGGER IF EXISTS event_private_no_update",
    );
    db.exec(statement);
  } finally {
    db.close();
  }
}

async function solo() {
  const r = g6Repo("sek-c5-ledger-");
  const { db, log } = openLocalLedger(r.repo);
  const cardStore = new CardStore(db, log);
  for (const id of ["c1", "c2", "c3"])
    await cardStore.createCard({ id, tier: "story", title: `Card ${id}` });
  const server = await startDashboardServer({
    db,
    log,
    boardService: new BoardServiceImpl(cardStore),
    cardStore,
    repoPath: r.repo,
    port: 0,
    streamIntervalMs: 60_000,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const file = join(r.repo, ".sekhemet", "events.db");
  const integrity = async () => {
    const res = await fetch(`${base}/api/integrity`);
    return {
      status: res.status,
      body: (await res.json()) as {
        chain: { valid: boolean; corruptedSeq?: number; reason?: string };
        projections?: { valid: boolean; reason?: string };
      },
    };
  };
  const lastSeq = () => (db.prepare("SELECT MAX(seq) AS n FROM events").get() as { n: number }).n;
  return {
    base,
    file,
    integrity,
    lastSeq,
    close: async () => {
      await server.close();
      db.close();
    },
  };
}

describe("tamper detection while the server runs (K-N1-8, K-N1-9)", () => {
  it("K-N1-8: an earlier row edited through another connection after the server verified the chain is reported at its seq by /api/integrity", async () => {
    const s = await solo();
    try {
      expect((await s.integrity()).body.chain.valid).toBe(true);
      tamper(s.file, "UPDATE events SET created_at = '2001-01-01 00:00:00' WHERE seq = 2");
      const after = await s.integrity();
      expect(after.status).toBe(200);
      expect(after.body.chain).toMatchObject({ valid: false, corruptedSeq: 2 });
    } finally {
      await s.close();
    }
  });

  it("K-N1-9: a payload replaced with JSON that does not fit its schema, or with no JSON at all, is a named integrity failure, not a 500", async () => {
    const s = await solo();
    try {
      expect((await s.integrity()).body.chain.valid).toBe(true);
      tamper(s.file, `UPDATE events SET payload = '{"unexpected":[1,2,3]}' WHERE seq = 3`);
      const misfit = await s.integrity();
      expect(misfit.status).toBe(200);
      expect(misfit.body.chain).toMatchObject({ valid: false, corruptedSeq: 3 });
      tamper(s.file, "UPDATE events SET payload = 'not json at all' WHERE seq = 3");
      const garbage = await s.integrity();
      expect(garbage.status).toBe(200);
      expect(garbage.body.chain).toMatchObject({ valid: false, corruptedSeq: 3 });
      expect(garbage.body.chain.reason).toMatch(/seq 3/);
    } finally {
      await s.close();
    }
  });
});

describe("GET /healthz (RUN-72)", () => {
  it("RUN-72: answers 200 with no data and no session while the ledger opens and its head verifies, and 503 once the head row is edited", async () => {
    const s = await solo();
    try {
      const ok = await fetch(`${s.base}/healthz`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get("cache-control")).toBe("no-store");
      expect((await ok.text()).trim()).toBe("ok");
      tamper(
        s.file,
        `UPDATE events SET created_at = '2001-01-01 00:00:00' WHERE seq = ${s.lastSeq()}`,
      );
      const down = await fetch(`${s.base}/healthz`);
      expect(down.status).toBe(503);
      const text = await down.text();
      expect(text.trim()).toBe("unavailable");
      expect(text).not.toMatch(/seq|hash|events/i);
    } finally {
      await s.close();
    }
  });

  it("RUN-72: a Team `serve` answers /healthz with no session while /api answers 401", async () => {
    const p = place("sek-c5-healthz-");
    const repoGit = (...a: string[]) =>
      spawn("git", ["-c", "user.email=e@x", "-c", "user.name=E", ...a], { cwd: p.repo });
    await new Promise((ok) => repoGit("init", "-q", "-b", "main").once("close", ok));
    const user = join(p.root, "team.toml");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(user, '[team]\nmode = "team"\nworkspace = "Northwind"\n');
    const s = spawnCli(["serve", "--port", String(await freePort())], p, {
      env: { SEKHEMET_USER_CONFIG: user },
    });
    try {
      const [url] = (await s.until(/http:\/\/127\.0\.0\.1:\d+/, 60_000)) as RegExpMatchArray;
      const health = await fetch(`${url}/healthz`);
      expect(health.status, s.out()).toBe(200);
      expect((await health.text()).trim()).toBe("ok");
      expect((await fetch(`${url}/api/cards`)).status).toBe(401);
    } finally {
      await s.stop();
    }
  }, 120_000);
});

describe("the traces store waits out another process (RUN-15)", () => {
  it("RUN-15: `queue`'s start-up trace prune waits for a lock another process holds on traces.db rather than failing", async () => {
    const p = await queueProject({
      files: { "src/a.ts": "", "src/main.ts": 'import { a } from "./a.js";\nconsole.log(a);\n' },
      cards: [
        { id: "c1", tier: "story", title: "Write a", scopeFiles: ["src/a.ts"], stepBudget: 3 },
      ],
    });
    const traces = join(p.repo, ".sekhemet", "traces.db");
    // Another process holds traces.db exclusively for three seconds.
    const holder = spawn(
      process.execPath,
      [
        "-e",
        `const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(${JSON.stringify(traces)});
db.exec("PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS spans (trace_id TEXT NOT NULL, span_id TEXT PRIMARY KEY, parent_span_id TEXT, name TEXT NOT NULL, start_ns TEXT NOT NULL, end_ns TEXT, attributes TEXT NOT NULL, status TEXT NOT NULL)");
db.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN IMMEDIATE; INSERT INTO spans VALUES ('t', 's', NULL, 'n', '0', '1', '{}', 'ok'); COMMIT;");
process.stdout.write("held\\n");
setTimeout(() => db.close(), 3000);`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const released = new Promise((ok) => holder.once("exit", ok));
    await new Promise((ok) => holder.stdout?.once("data", ok));
    const engine = await startEngine(p.home, [
      {
        calls: [
          { name: "write_file", arguments: { path: "src/a.ts", content: "export const a = 1;\n" } },
          { name: "finish_card" },
        ],
      },
    ]);
    const r = await runQueueOn(p, engine);
    await released;
    const out = r.stdout + r.stderr;
    expect(out).not.toMatch(/database is locked/);
    expect(r.status, out).toBe(0);
    expect(out).toMatch(/PASSED \(gate_passed\)/);
    // It waited for the lock, then pruned: the holder's old span is gone.
    expect(out).toMatch(/Retention: 1 span older than 30 days deleted/);
  }, 180_000);
});
