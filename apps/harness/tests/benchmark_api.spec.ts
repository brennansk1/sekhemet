import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type ScreeningSets, resolveRunProfile } from "@sekhemet/eval";
import { EventLog, initSchema } from "@sekhemet/kernel";
import { withMeasurementRun } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import { createBenchmarkApi } from "../src/benchmark_api.js";
import { type BenchmarkEnv, BenchmarkService } from "../src/benchmark_cmd.js";
import { CONFIG_ROUTES } from "../src/config_routes.js";

// PM_CONTRACT §3 Configuration, the two-tier benchmark: the routes of
// `config_routes.ts` whose module is `benchmark_api`, over a real HTTP
// server, a real ledger and a fake screening runner. No model.

const dirs: string[] = [];
const servers: Server[] = [];
const dbs: DatabaseSync[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
  for (const db of dbs.splice(0)) db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

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
        expectedSize: 6,
        items: Array.from({ length: 6 }, (_, i) => ({ id: `w${i}` })),
        hash: "b".repeat(64),
      },
      planner: not("planner"),
      reviewer: not("reviewer"),
      researcher: not("researcher"),
    },
    endToEnd: { version: "1", capSeconds: 180, items: [{ id: "e1" }, { id: "e2" }] },
  };
}

async function start(fit: BenchmarkEnv["fit"] = () => ({ fits: true })) {
  const dir = mkdtempSync(join(tmpdir(), "bench-api-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".sekhemet"), { recursive: true });
  const db = new DatabaseSync(join(dir, ".sekhemet", "events.db"));
  dbs.push(db);
  initSchema(db);
  const log = new EventLog(db);
  const env: BenchmarkEnv = {
    repoPath: dir,
    log,
    host: "host-a",
    sets,
    overnightSets: () => ({
      roles: {
        worker: { state: "ready", runs: 2, cards: [{ id: "s1", role: "worker" }] },
        planner: { state: "not_built", runs: 1, cards: [] },
        reviewer: { state: "not_built", runs: 1, cards: [] },
        researcher: { state: "not_built", runs: 1, cards: [] },
      },
    }),
    machine: () => ({ reservedHours: "08:00-18:00 Mon-Fri" }),
    fit,
    cacheKey: (_r, model, setHash) => ({
      model,
      quantisation: "Q4",
      engine: "llama.cpp",
      settings: "s",
      host: "host-a",
      contextVersion: "c",
      setHash,
    }),
    throughput: async () => ({ secondsPerItem: () => undefined, loadSeconds: () => undefined }),
    runProfile: () => resolveRunProfile({ env: {}, argv: [] }),
    measurementRun: (run) => withMeasurementRun({ releaseAll: async () => undefined }, run),
    screenRunner: () => ({
      load: async () => ({ seconds: 1 }),
      runItem: async () => ({ outcome: { kind: "tests", passed: 3, total: 4 }, seconds: 5 }),
      endToEnd: async () => ({ passed: true, seconds: 5 }),
    }),
    fingerprint: () => ({ build: "b", contextVersion: "c", qualification: "q" }),
  };
  const service = new BenchmarkService(env);
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const readJsonBody = (req: IncomingMessage) =>
    new Promise<Record<string, unknown>>((resolve) => {
      let raw = "";
      req.on("data", (c) => {
        raw += c;
      });
      req.on("end", () => resolve(raw ? JSON.parse(raw) : {}));
    });
  const api = createBenchmarkApi({
    service,
    json,
    readJsonBody,
    isTrustedMutation: (req) => req.headers["x-sekhemet-action"] === "1",
    principalOf: () => "p_owner",
    mayManage: (req) => req.headers["x-test-level"] !== "member",
  });
  const server = createServer(async (req, res) => {
    const handled = await api.handle(req, res, (req.url ?? "").split("?")[0] ?? "");
    if (!handled) json(res, 404, { error: "not a benchmark route" });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    trusted = true,
    level = "admin",
  ) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-test-level": level,
        ...(trusted ? { "x-sekhemet-action": "1" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { call, log, service };
}

const COMBO = { worker: "wa", planner: "p" };

describe("the benchmark API (PM_CONTRACT §3 Configuration)", () => {
  it("serves every benchmark route in the route table", () => {
    const api = createBenchmarkApi({
      service: {} as BenchmarkService,
      json: () => undefined,
      readJsonBody: async () => ({}),
      isTrustedMutation: () => true,
      mayManage: () => true,
    });
    const table = CONFIG_ROUTES.filter((r) => r.module === "benchmark_api").map(
      (r) => `${r.method} ${r.path}`,
    );
    expect(api.routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual(table.sort());
  });

  it("estimates a quick screen without running it, starts it, reports the run and the results by combination", async () => {
    const { call } = await start();
    const est = await call("GET", "/api/config/benchmark/estimate?tier=quick&worker=wa&planner=p");
    expect(est.status).toBe(200);
    expect(est.body.toMeasure).toEqual([{ role: "worker", model: "wa" }]);
    expect(est.body.estimateSeconds).toBeGreaterThan(0);
    expect(est.body.copy).toMatch(/overnight benchmark settles close calls/);

    const started = await call("POST", "/api/config/benchmark", {
      tier: "quick",
      combinations: [COMBO],
    });
    expect(started.status).toBe(200);
    const run = started.body.run as { runId: string; tier: string };
    expect(run.tier).toBe("quick");
    for (let i = 0; i < 50; i++) {
      const r = await call("GET", `/api/config/benchmark/runs/${run.runId}`);
      if ((r.body.run as { state: string }).state === "done") break;
      await new Promise((res) => setTimeout(res, 10));
    }
    const all = await call("GET", "/api/config/benchmark");
    const results = all.body.results as { combinationId: string; tier: string }[];
    expect(results).toHaveLength(1);
    expect(results[0]?.tier).toBe("quick");
    expect(all.body.roleScores).toHaveLength(1);
    const history = await call("GET", `/api/config/benchmark/${results[0]?.combinationId}`);
    expect(history.body.results).toHaveLength(1);
    // Everything cached now: nothing to measure, 0 seconds (PM_CONTRACT).
    const again = await call(
      "GET",
      `/api/config/benchmark/estimate?tier=quick&combination=${results[0]?.combinationId}`,
    );
    expect(again.body).toMatchObject({ estimateSeconds: 0, toMeasure: [] });
  });

  it("refuses a change from a person without config.manage, however the route was reached (defence in depth)", async () => {
    const { call, log } = await start();
    const quick = { tier: "quick", combinations: [COMBO] };
    expect((await call("POST", "/api/config/benchmark", quick, true, "member")).status).toBe(403);
    expect(
      (await call("POST", "/api/config/benchmark/runs/bench_x/stop", {}, true, "member")).status,
    ).toBe(403);
    // A variant spelling is no benchmark route at all.
    for (const path of [
      "/api/config/benchmark/",
      "/api//config/benchmark",
      "/api/config/%62enchmark",
    ])
      expect((await call("POST", path, quick)).status).toBe(404);
    expect(await log.getEventsByTypes(["measure/benchmark_started"])).toEqual([]);
    // A read stays open.
    expect((await call("GET", "/api/config/benchmark", undefined, true, "member")).status).toBe(
      200,
    );
  });

  it("refuses a model that does not fit with 409 and the GB it needs", async () => {
    const { call } = await start(() => ({ fits: false, needsGb: 21 }));
    const r = await call("POST", "/api/config/benchmark", { tier: "quick", combinations: [COMBO] });
    expect(r.status).toBe(409);
    expect(r.body.needsGb).toBe(21);
  });

  it("refuses a change that is not the dashboard's own action, and a quick run of other than one combination", async () => {
    const { call } = await start();
    expect(
      (await call("POST", "/api/config/benchmark", { tier: "quick", combinations: [COMBO] }, false))
        .status,
    ).toBe(403);
    expect(
      (await call("POST", "/api/config/benchmark", { tier: "quick", combinations: [] })).status,
    ).toBe(400);
  });

  it("queues an overnight comparison with its schedule, stops it and reports an unknown run as 404", async () => {
    const { call } = await start();
    const q = await call("POST", "/api/config/benchmark", {
      tier: "overnight",
      combinations: [COMBO, { worker: "wb", planner: "p" }],
    });
    expect(q.status).toBe(200);
    const run = q.body.run as { runId: string; state: string; schedule: { fitsTonight: number } };
    expect(run.state).toBe("queued");
    expect(q.body.schedule).toMatchObject({ fitsTonight: expect.any(Number) });
    const stopped = await call("POST", `/api/config/benchmark/runs/${run.runId}/stop`);
    expect((stopped.body.run as { state: string }).state).toBe("stopped");
    expect((await call("GET", "/api/config/benchmark/runs/bench_nope")).status).toBe(404);
    const est = await call("GET", "/api/config/benchmark/estimate?tier=overnight&count=2");
    expect(est.body).toMatchObject({ fitsTonight: expect.any(Number) });
  });
});
