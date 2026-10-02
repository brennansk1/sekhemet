import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { type ScreeningSets, resolveRunProfile } from "@sekhemet/eval";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import {
  MockInferenceAdapter,
  ModelRegistry,
  type ModelRole,
  type UnloadableAdapter,
  assignRole,
  hostFingerprintHash,
  withMeasurementRun,
} from "@sekhemet/models";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SMALL, writeGguf } from "../../../packages/models/tests/support/gguf_fixture.js";
import type { BenchmarkEnv } from "../src/benchmark_cmd.js";
import { createConfigApi } from "../src/config_api.js";
import { dashboardResidency } from "../src/config_model_actions.js";
import { ModelAccess } from "../src/model_access.js";
import { startDashboardServer } from "../src/server.js";
import { pageWriteHeaders } from "./page_headers.js";

// B4.1 wiring (dashboard NEW-dashboard-6, measurement NEW-measurement-5):
// the benchmark API mounted on the dashboard, Load/Unload through the
// dashboard's residency scheduler, Qualify to assign running the check, and
// the background model hashing yielding to a load in flight. A real server,
// a real ledger and real model files (tiny GGUF headers); every adapter is a
// fake, so no model is loaded.

const GB = 1024 ** 3;
let dir: string;
const closers: (() => Promise<void> | void)[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sek-cfg-wire-"));
  const user = join(dir, "user.toml");
  writeFileSync(user, '[team]\nmode = "solo"\n');
  vi.stubEnv("SEKHEMET_USER_CONFIG", user);
  vi.stubEnv("SEKHEMET_MODEL_REGISTRY", join(dir, "models.json"));
  vi.stubEnv("SEKHEMET_CONFIG_DIR", join(dir, "config-dir"));
  vi.stubEnv("SEKHEMET_MODELS_DIR", join(dir, "models"));
  writeGguf(join(dir, "models", "tiny-Q4_K_M.gguf"), { ...SMALL, name: "Tiny", padBytes: 1024 });
});
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

/** A fake model: its load waits until `release` is called when `gate` is set. */
function fakeResolve(events: string[], gate?: { wait: Promise<void> }) {
  return (name: string): UnloadableAdapter => ({
    modelId: name,
    supportedArms: ["arm_a_flat"],
    contextWindow: { contextTokens: 8192, maxTokens: 1024 },
    generate: async () => ({
      text: name,
      toolCalls: [],
      usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
    }),
    load: async () => {
      events.push(`load ${name}`);
      if (gate) await gate.wait;
      return "loaded";
    },
    unload: async () => {
      events.push(`unload ${name}`);
    },
    confirmUnloaded: async () => true,
    footprintBytes: async () => 4 * GB,
  });
}

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
        expectedSize: 2,
        items: [{ id: "w0" }, { id: "w1" }],
        hash: "b".repeat(64),
      },
      planner: not("planner"),
      reviewer: not("reviewer"),
      researcher: not("researcher"),
    },
    endToEnd: { version: "1", capSeconds: 180, items: [{ id: "e1" }] },
  };
}

/** The benchmark's real environment with a scripted runner and small sets: no model runs. */
const scripted = (env: BenchmarkEnv): BenchmarkEnv => ({
  ...env,
  sets,
  throughput: async () => ({ secondsPerItem: () => undefined, loadSeconds: () => undefined }),
  runProfile: () => resolveRunProfile({ env: {}, argv: [] }),
  measurementRun: (run) => withMeasurementRun({ releaseAll: async () => undefined }, run),
  screenRunner: () => ({
    load: async () => ({ seconds: 1 }),
    runItem: async () => ({ outcome: { kind: "tests", passed: 3, total: 4 }, seconds: 5 }),
    endToEnd: async () => ({ passed: true, seconds: 5 }),
  }),
  fingerprint: () => ({ build: "b", contextVersion: "c", qualification: "q" }),
});

async function serve(o: {
  access?: ModelAccess;
  qualifyAdapter?: (model: string, role: ModelRole) => MockInferenceAdapter;
}) {
  const root = join(dir, "repo");
  mkdirSync(root, { recursive: true });
  const db = new DatabaseSync(join(root, "events.db"));
  initSchema(db);
  const log = new EventLog(db);
  const cardStore = new CardStore(db, log);
  const server = await startDashboardServer({
    db,
    log,
    boardService: new BoardServiceImpl(cardStore),
    cardStore,
    repoPath: root,
    port: 0,
    streamIntervalMs: 1000,
    benchmarkEnv: scripted,
    // The fit from this machine's total memory, not the live reading (deterministic).
    headroomProbe: null,
    ...(o.access ? { modelAccess: o.access } : {}),
    ...(o.qualifyAdapter ? { qualifyAdapter: o.qualifyAdapter } : {}),
  });
  closers.push(
    () => db.close(),
    () => server.close(),
  );
  const base = `http://127.0.0.1:${server.port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(await pageWriteHeaders(base)) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { call, log, root, base };
}

describe("the benchmark API on the dashboard (NEW-measurement-5, DB-N6-9–13)", () => {
  it("serves the benchmark routes: results, an estimate, a quick screen started and its run read back", async () => {
    const { call, log } = await serve({});
    const results = await call("GET", "/api/config/benchmark");
    expect(results.status).toBe(200);
    expect(results.body).toHaveProperty("results");
    const est = await call("GET", "/api/config/benchmark/estimate?worker=w&planner=p");
    expect(est.status).toBe(200);
    const started = await call("POST", "/api/config/benchmark", {
      tier: "quick",
      combinations: [{ worker: "w", planner: "p" }],
    });
    expect(started.status).toBe(200);
    const runId = (started.body.run as { runId: string }).runId;
    for (let i = 0; i < 100; i++) {
      const r = await call("GET", `/api/config/benchmark/runs/${runId}`);
      if ((r.body.run as { state: string }).state === "done") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const done = await call("GET", `/api/config/benchmark/runs/${runId}`);
    expect((done.body.run as { state: string }).state).toBe("done");
    // Recorded with the person's principal; nothing assigned (DB-N6-13).
    const startedEv = (await log.getEventsByTypes(["measure/benchmark_started"])).at(-1);
    expect(startedEv?.principal).toBeTruthy();
    expect(await log.getEventsByTypes(["models/assigned"])).toEqual([]);
  });
});

describe("Load, Unload and Qualify to assign on the dashboard (DB-N6-4, rule 20a, rule 27a)", () => {
  it("loads and unloads an assigned role's model through the dashboard's scheduler, not 409", async () => {
    const events: string[] = [];
    const access = ModelAccess.forQueues([], {
      resolve: fakeResolve(events),
      usableBytes: 64 * GB,
      healthCheck: false,
    });
    const reg = new ModelRegistry(join(dir, "models.json"));
    reg.recordQualification("fake-worker", {
      suiteVersion: "q1",
      passRate: 1,
      status: "qualified",
    });
    assignRole(reg, {
      role: "worker",
      model: "fake-worker",
      scope: "personal",
      by: "person: test",
      host: hostFingerprintHash(),
      qualification: "qualified",
    });
    const { call } = await serve({ access });
    const loaded = await call("POST", "/api/config/roles/worker/load");
    expect(loaded.status).toBe(200);
    expect((loaded.body.role as { state: string }).state).toBe("resident");
    expect(events).toEqual(["load fake-worker"]);
    const unloaded = await call("POST", "/api/config/roles/worker/unload");
    expect(unloaded.status).toBe(200);
    expect((unloaded.body.role as { state: string }).state).toBe("swapped_out");
    expect(events).toEqual(["load fake-worker", "unload fake-worker"]);
  });

  it("runs the qualification on Qualify to assign, and answers with its result rather than 409", async () => {
    const asked: string[] = [];
    const { call } = await serve({
      qualifyAdapter: (model, role) => {
        asked.push(`${role}:${model}`);
        // Answers every case with plain text and no tool call: it does not qualify.
        return new MockInferenceAdapter(model, [
          {
            text: "I cannot help with that.",
            toolCalls: [],
            usage: { promptTokens: 10, completionTokens: 8, durationMs: 5 },
          },
        ]);
      },
    });
    const r = await call("POST", "/api/config/roles/planner/qualify", { model: "fake-planner" });
    expect(r.status).toBe(200);
    expect(r.body.qualified).toBe(false);
    // Scored, not crashed: the reason is the score against the bar (compliance
    // C6; the old pattern also matched "could not run" and hid a crash).
    expect(String(r.body.reason)).toMatch(
      /^\d+% of the check that verifies it on this machine passed; it needs \d+%\.$/,
    );
    expect(String(r.body.reason)).not.toMatch(/could not run/);
    expect(asked).toEqual(["planner:fake-planner"]);
  }, 60_000);
});

describe("the background model hashing yields to a model load (DB-N6, models rule 20h)", () => {
  it("defers the first hash while the scheduler has a load in flight, and hashes once it ends", async () => {
    const root = join(dir, "repo");
    mkdirSync(root, { recursive: true });
    const db = new DatabaseSync(join(root, "events.db"));
    initSchema(db);
    closers.push(() => db.close());
    const log = new EventLog(db);
    let release = () => {};
    const gate = {
      wait: new Promise<void>((r) => {
        release = r;
      }),
    };
    const events: string[] = [];
    const access = ModelAccess.forQueues([], {
      resolve: fakeResolve(events, gate),
      usableBytes: 64 * GB,
      healthCheck: false,
    });
    const residency = dashboardResidency(() => access);
    const frames: Record<string, unknown>[] = [];
    const api = createConfigApi({
      repoPath: root,
      log,
      json: () => {},
      readJsonBody: async () => ({}),
      isTrustedMutation: () => true,
      principalOf: () => "p_owner",
      registry: new ModelRegistry(join(dir, "models.json")),
      headroomProbe: null,
      hashCachePath: join(dir, "hashes.json"),
      residency,
      yieldPollMs: 10,
      emit: (f) => frames.push(f),
    });
    closers.push(() => api.close());
    const loading = residency.load("worker", "slow-model");
    for (let i = 0; i < 200 && !residency.loading?.(); i++)
      await new Promise((r) => setTimeout(r, 5));
    expect(residency.loading?.()).toBe(true);
    await api.scan();
    await new Promise((r) => setTimeout(r, 200));
    expect(frames.filter((f) => f.kind === "hash")).toEqual([]);
    release();
    expect(await loading).toEqual({ ok: true });
    await api.hashingDone();
    expect(frames.filter((f) => f.kind === "hash").length).toBe(1);
  });
});

describe("Use the recommended models (DB-N6-16)", () => {
  it("lists every download with its source, size and hash, and starts none without the person's confirmation", async () => {
    let hits = 0;
    const { createServer } = await import("node:http");
    const hub = createServer((_req, res) => {
      hits++;
      res.end("x");
    });
    await new Promise<void>((r) => hub.listen(0, "127.0.0.1", () => r()));
    closers.push(() => new Promise<void>((r) => hub.close(() => r())));
    const port = (hub.address() as { port: number }).port;
    vi.stubEnv("SEKHEMET_MODELS_DIR", join(dir, "no-models"));
    mkdirSync(join(dir, "no-models"), { recursive: true });
    const reg = new ModelRegistry(join(dir, "models.json"));
    reg.upsert("remote-w", { sizeBytes: 1000, roles: ["worker"] });
    reg.recordSource("remote-w", {
      url: `http://127.0.0.1:${port}/w.gguf`,
      host: "127.0.0.1",
      sha256: "a".repeat(64),
      sizeBytes: 1000,
    });
    const { call, log } = await serve({});
    const shown = await call("GET", "/api/config/recommended");
    expect(shown.status).toBe(200);
    expect(shown.body.downloads).toEqual([
      {
        model: "remote-w",
        roles: ["worker"],
        url: `http://127.0.0.1:${port}/w.gguf`,
        host: "127.0.0.1",
        sizeBytes: 1000,
        sha256: "a".repeat(64),
      },
    ]);
    expect(shown.body.folder).toBe(join(dir, "no-models"));
    const refused = await call("POST", "/api/config/recommended", {});
    expect(refused.status).toBe(409);
    expect(refused.body.downloads).toEqual(shown.body.downloads);
    // A bare "yes" confirms nothing: the confirmation names the downloads and the folder.
    const bare = await call("POST", "/api/config/recommended", { confirm: true });
    expect(bare.status).toBe(409);
    const folder = shown.body.folder;
    const other = await call("POST", "/api/config/recommended", {
      confirm: true,
      folder,
      downloads: [{ model: "remote-w", sha256: "b".repeat(64) }],
    });
    expect(other.status).toBe(409);
    expect(other.body.error).toMatch(/not the ones recommended now/);
    const extra = await call("POST", "/api/config/recommended", {
      confirm: true,
      folder,
      downloads: [
        { model: "remote-w", sha256: "a".repeat(64) },
        { model: "remote-x", sha256: "c".repeat(64) },
      ],
    });
    expect(extra.status).toBe(409);
    const elsewhere = await call("POST", "/api/config/recommended", {
      confirm: true,
      folder: join(dir, "elsewhere"),
      downloads: [{ model: "remote-w", sha256: "a".repeat(64) }],
    });
    expect(elsewhere.status).toBe(409);
    expect(elsewhere.body.error).toMatch(/only into a model folder you added/);
    expect(hits).toBe(0);
    expect(await log.getEventsByTypes(["model/downloaded", "models/assigned"])).toEqual([]);
    // What the person saw, named back: the download starts.
    const ok = await call("POST", "/api/config/recommended", {
      confirm: true,
      folder,
      downloads: [{ model: "remote-w", sha256: "a".repeat(64) }],
    });
    expect(ok.status).toBe(202);
    for (let i = 0; i < 200 && hits === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(hits).toBeGreaterThan(0);
  });

  it("screens the recommended combination with the quick benchmark, assigns the qualified roles with the person's principal, and says why the others were not", async () => {
    const reg = new ModelRegistry(join(dir, "models.json"));
    reg.recordQualification("tiny", { suiteVersion: "q1", passRate: 1, status: "qualified" });
    const { call, log } = await serve({});
    const shown = await call("GET", "/api/config/recommended");
    expect(shown.body.downloads).toEqual([]);
    expect(shown.body.combination).toMatchObject({ worker: "tiny", planner: "tiny" });
    const started = await call("POST", "/api/config/recommended", {});
    expect(started.status).toBe(202);
    let last: Record<string, unknown> | undefined;
    for (let i = 0; i < 200; i++) {
      last = (await call("GET", "/api/config/recommended")).body.last as Record<string, unknown>;
      if (last?.state === "done") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(last?.state).toBe("done");
    const assigned = last?.assigned as { role: string; model: string }[];
    const notAssigned = last?.notAssigned as { role: string; reason: string }[];
    expect(assigned.map((a) => a.role).sort()).toEqual(["planner", "researcher", "worker"]);
    expect(notAssigned.map((a) => a.role)).toEqual(["reviewer"]);
    expect(notAssigned[0]?.reason.length).toBeGreaterThan(0);
    // The quick benchmark screened the combination, recorded with the person.
    const bench = await log.getEventsByTypes(["measure/benchmark_started"]);
    expect(bench).toHaveLength(1);
    expect(bench[0]?.principal).toBeTruthy();
    expect(last?.benchmark).toMatchObject({ state: "done" });
    const events = await log.getEventsByTypes(["models/assigned"]);
    expect(events.map((e) => (e.payload as { role: string }).role).sort()).toEqual([
      "planner",
      "researcher",
      "worker",
    ]);
    for (const e of events) expect(e.principal).toBe(bench[0]?.principal);
  });
});

describe("Use the recommended models in the page (DB-N6-16, Chromium)", () => {
  it("shows one confirmation, then what was assigned and why the others were not", async () => {
    const { chromium } = await import("playwright-core");
    const reg = new ModelRegistry(join(dir, "models.json"));
    reg.recordQualification("tiny", { suiteVersion: "q1", passRate: 1, status: "qualified" });
    const { base, log } = await serve({});
    const browser = await chromium.launch();
    closers.push(() => browser.close());
    const page = await (
      await browser.newContext({ viewport: { width: 1280, height: 900 } })
    ).newPage();
    await page.goto(`${base}/#/configuration/models`);
    // DB-N19-5: *Apply suggestion* opens the same one confirmation (DB-N6-16).
    await page.getByRole("button", { name: "Apply suggestion" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText("Nothing to download.").waitFor();
    expect(await log.getEventsByTypes(["models/assigned"])).toEqual([]);
    await dialog.getByRole("button", { name: "Use them" }).click();
    await page.getByText("Coding model: tiny assigned").waitFor({ timeout: 20_000 });
    await page.getByText(/Review model: not assigned — /).waitFor();
    expect((await log.getEventsByTypes(["models/assigned"])).length).toBe(3);
  }, 60_000);
});
