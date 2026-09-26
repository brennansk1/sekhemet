import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { type ScreeningSets, resolveRunProfile } from "@sekhemet/eval";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BenchmarkEnv } from "../src/benchmark_cmd.js";
import { startDashboardServer } from "../src/server.js";

// B4.1 half-B review, the blocker: a benchmark route reached by a path its
// permission rule does not match (a trailing slash, a doubled slash, an
// encoded letter) must never fall back to a Member's `issue.edit`. Real
// server, real ledger, a scripted benchmark runner: no model runs.

let repo: string;
let db: DatabaseSync;
let log: EventLog;
let server: { port: number; close: () => Promise<void> } | undefined;

const ADMIN = "p_admin";
const MEMBER = "p_member";

function sets(): ScreeningSets {
  const not = (role: "planner" | "reviewer" | "researcher") => ({
    role,
    version: "1",
    state: "not_built" as const,
    reason: "not built",
    capSeconds: 60,
    expectedSize: 3,
    items: [],
  });
  return {
    roles: {
      worker: {
        role: "worker",
        version: "1",
        state: "ready",
        capSeconds: 120,
        expectedSize: 1,
        items: [{ id: "w0" }],
        hash: "b".repeat(64),
      },
      planner: not("planner"),
      reviewer: not("reviewer"),
      researcher: not("researcher"),
    },
    endToEnd: { version: "1", capSeconds: 180, items: [{ id: "e1" }] },
  };
}

const scripted = (env: BenchmarkEnv): BenchmarkEnv => ({
  ...env,
  sets,
  fit: () => ({ fits: true }),
  throughput: async () => ({ secondsPerItem: () => undefined, loadSeconds: () => undefined }),
  runProfile: () => resolveRunProfile({ env: {}, argv: [] }),
  measurementRun: (run) => run(),
  screenRunner: () => ({
    load: async () => ({ seconds: 1 }),
    runItem: async () => ({ outcome: { kind: "tests", passed: 1, total: 1 }, seconds: 1 }),
    endToEnd: async () => ({ passed: true, seconds: 1 }),
  }),
  fingerprint: () => ({ build: "b", contextVersion: "c", qualification: "q" }),
});

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "sek-bench-access-"));
  writeFileSync(join(repo, "noop.mjs"), "");
  process.env.SEKHEMET_CLI = join(repo, "noop.mjs");
  db = new DatabaseSync(join(repo, "events.db"));
  initSchema(db);
  log = new EventLog(db);
  for (const [principal, level] of [
    [ADMIN, "admin"],
    [MEMBER, "member"],
  ] as const) {
    log.appendNow({
      actor: "system",
      type: "member/joined",
      principal,
      payload: { principal, level, via: "invite", pending: false },
    });
  }
  const store = new CardStore(db, log);
  server = await startDashboardServer({
    db,
    log,
    boardService: new BoardServiceImpl(store),
    cardStore: store,
    repoPath: repo,
    port: 0,
    streamIntervalMs: 10_000,
    setup: "team",
    headroomProbe: null,
    benchmarkEnv: scripted,
    requester: (req) => {
      const h = req.headers["x-test-principal"];
      return typeof h === "string" && h ? h : undefined;
    },
  });
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  Reflect.deleteProperty(process.env, "SEKHEMET_CLI");
  db.close();
  rmSync(repo, { recursive: true, force: true });
});

const send = async (who: string, path: string, body: unknown = {}) => {
  const res = await fetch(`http://127.0.0.1:${server?.port}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Sekhemet-Action": "1",
      "X-Test-Principal": who,
    },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    data: (await res.json().catch(() => ({}))) as Record<string, unknown>,
  };
};

const QUICK = { tier: "quick", combinations: [{ worker: "w", planner: "p" }] };

describe("the benchmark's writes need config.manage on every spelling of their path", () => {
  it("answers a Member 403 on the exact routes and on a trailing slash, a doubled slash and an encoded letter", async () => {
    const variants = [
      "/api/config/benchmark",
      "/api/config/benchmark/",
      "/api//config/benchmark",
      "/api/config/%62enchmark",
      "/api/config/benchmark/runs/bench_x/stop",
      "/api/config/benchmark/runs/bench_x/stop/",
      "/api/config//benchmark/runs/bench_x/stop",
    ];
    for (const path of variants) {
      const r = await send(MEMBER, path, QUICK);
      expect({ path, status: r.status }).toEqual({ path, status: 403 });
    }
    expect(await log.getEventsByTypes(["measure/benchmark_started"])).toEqual([]);
  });

  it("serves an Admin on the exact route only; a variant spelling is not a benchmark route", async () => {
    expect((await send(ADMIN, "/api/config/benchmark/", QUICK)).status).not.toBe(200);
    expect((await send(ADMIN, "/api/config/%62enchmark", QUICK)).status).not.toBe(200);
    expect(await log.getEventsByTypes(["measure/benchmark_started"])).toEqual([]);
    expect((await send(ADMIN, "/api/config/benchmark", QUICK)).status).toBe(200);
  });
});
