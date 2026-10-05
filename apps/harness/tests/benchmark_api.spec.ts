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

async function start(
  fit: BenchmarkEnv["fit"] = () => ({ fits: true }),
  over: Partial<BenchmarkEnv> = {},
) {
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
    hostReading: () => ({ swapUsedBytes: 0, freeRatio: 0.8 }),
    incumbent: () => ({ temperature: 0.7, reasoningPolicy: "surgical", method: "baseline" }),
    ...over,
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

describe("settings, history and Find best settings over HTTP (NEW-measurement-7, -8; DB-N6-19..22)", () => {
  /** A screening runner whose temperature 0.2 passes every test and anything else three of four. */
  const tempRunner = (): BenchmarkEnv["screenRunner"] => () => ({
    load: async () => ({ seconds: 1 }),
    runItem: async ({ settings }) => ({
      outcome: {
        kind: "tests",
        passed: (settings as { temperature?: number } | undefined)?.temperature === 0.2 ? 4 : 3,
        total: 4,
      },
      seconds: 5,
    }),
    endToEnd: async () => ({ passed: true, seconds: 5 }),
  });

  const until = async (
    call: Awaited<ReturnType<typeof start>>["call"],
    runId: string,
  ): Promise<Record<string, unknown>> => {
    for (let i = 0; i < 100; i++) {
      const r = await call("GET", "/api/config/benchmark/tune?role=worker&model=wa");
      const run = (r.body.runs as { runId: string; state: string }[]).find(
        (x) => x.runId === runId,
      );
      if (run && run.state !== "running") return run as Record<string, unknown>;
      await new Promise((res) => setTimeout(res, 10));
    }
    throw new Error("the tune run did not finish");
  };

  it("estimates Find best settings with its candidates in words, runs it only on a confirmation, and applies a best run's values on the person's press", async () => {
    const applied: unknown[] = [];
    const { call, log } = await start(undefined, {
      screenRunner: tempRunner(),
      applySettings: (model, role, values) => {
        applied.push({ model, role, values });
        return { needsVerifying: true };
      },
    });
    const est = await call("GET", "/api/config/benchmark/tune?role=worker&model=wa");
    expect(est.status).toBe(200);
    const estimate = est.body.estimate as {
      candidates: { id: string; words: string }[];
      minutes: number;
    };
    expect(estimate.candidates.map((c) => c.words)).toContain("temperature 0.2");
    expect(estimate.minutes).toBeGreaterThan(0);
    expect(est.body.runs).toEqual([]);

    const unconfirmed = await call("POST", "/api/config/benchmark/tune", {
      role: "worker",
      model: "wa",
    });
    expect(unconfirmed.status).toBe(400);
    expect(await log.getEventsByTypes(["measure/settings_tuned"])).toEqual([]);

    const started = await call("POST", "/api/config/benchmark/tune", {
      role: "worker",
      model: "wa",
      confirm: true,
    });
    expect(started.status).toBe(202);
    const runId = (started.body.run as { runId: string }).runId;
    const done = await until(call, runId);
    expect(done).toMatchObject({
      state: "done",
      verdict: "best",
      survivor: { values: { temperature: 0.2 }, words: "temperature 0.2" },
      adopted: { temperature: 0.2 },
    });
    expect(applied).toEqual([]);
    const apply = await call("POST", `/api/config/benchmark/tune/${runId}/apply`);
    expect(apply.status).toBe(200);
    expect(apply.body).toMatchObject({ applied: { temperature: 0.2 }, needsVerifying: true });
    expect(applied).toEqual([{ model: "wa", role: "worker", values: { temperature: 0.2 } }]);
    // A Member cannot start, stop or apply.
    for (const path of [
      "/api/config/benchmark/tune",
      `/api/config/benchmark/tune/${runId}/stop`,
      `/api/config/benchmark/tune/${runId}/apply`,
    ])
      expect(
        (await call("POST", path, { role: "worker", model: "wa", confirm: true }, true, "member"))
          .status,
      ).toBe(403);
  });

  it("refuses Find best settings for a role whose screen is not built, and over DEC-42's limits, with 409", async () => {
    const { call } = await start(undefined, { screenRunner: tempRunner() });
    const planner = await call("POST", "/api/config/benchmark/tune", {
      role: "planner",
      model: "p",
      confirm: true,
    });
    expect(planner.status).toBe(409);
    expect(planner.body.error).toMatch(/not built/);
    const hot = await start(undefined, {
      screenRunner: tempRunner(),
      hostReading: () => ({ swapUsedBytes: 0, freeRatio: 0.3 }),
    });
    const r = await hot.call("POST", "/api/config/benchmark/tune", {
      role: "worker",
      model: "wa",
      confirm: true,
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/30% of memory is free/);
  });

  it("answers 409 to Apply when a run found no clear difference", async () => {
    const { call } = await start();
    const started = await call("POST", "/api/config/benchmark/tune", {
      role: "worker",
      model: "wa",
      confirm: true,
    });
    const runId = (started.body.run as { runId: string }).runId;
    expect((await until(call, runId)).verdict).toBe("no_clear_difference");
    const apply = await call("POST", `/api/config/benchmark/tune/${runId}/apply`);
    expect(apply.status).toBe(409);
    expect(apply.body.error).toMatch(/nothing to apply/);
  });

  it("runs a combination with settings as its own row, refuses a value that needs its own load with 400, and serves the history", async () => {
    const { call } = await start(undefined, { screenRunner: tempRunner() });
    const tuned = { ...COMBO, settings: { worker: { temperature: 0.2 } } };
    const bad = await call("POST", "/api/config/benchmark", {
      tier: "quick",
      combinations: [{ ...COMBO, settings: { worker: { kvType: "q4_0" } } }],
    });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ key: "kvType" });
    expect(bad.body.error).toMatch(/Customize/);
    for (const c of [COMBO, tuned]) {
      const s = await call("POST", "/api/config/benchmark", { tier: "quick", combinations: [c] });
      expect(s.status).toBe(200);
      const runId = (s.body.run as { runId: string }).runId;
      for (let i = 0; i < 50; i++) {
        const r = await call("GET", `/api/config/benchmark/runs/${runId}`);
        if ((r.body.run as { state: string }).state === "done") break;
        await new Promise((res) => setTimeout(res, 10));
      }
    }
    const est = await call(
      "GET",
      `/api/config/benchmark/estimate?tier=quick&worker=wa&planner=p&settings=${encodeURIComponent(JSON.stringify(tuned.settings))}`,
    );
    expect(est.body).toMatchObject({ estimateSeconds: 0 });
    const all = await call("GET", "/api/config/benchmark");
    const rows = all.body.results as { combination: { settings?: unknown } }[];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.combination.settings ?? null)).toContainEqual({
      worker: { temperature: 0.2 },
    });
    const history = await call("GET", "/api/config/benchmark/history");
    expect(history.status).toBe(200);
    const combos = history.body.combinations as { runs: { settings?: unknown }[] }[];
    expect(combos).toHaveLength(2);
    expect(history.body.external).toMatchObject({
      capstone: expect.any(Array),
      webbench: expect.any(Array),
    });
    expect((history.body.external as { protocol: { capstone: string } }).protocol.capstone).toMatch(
      /hidden/,
    );
  });
});
