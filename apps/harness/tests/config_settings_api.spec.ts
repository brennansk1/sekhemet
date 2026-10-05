import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import {
  FakeHeadroomProbe,
  type MemoryReading,
  MockInferenceAdapter,
  ModelRegistry,
  type QualificationCombination,
  assignRole,
} from "@sekhemet/models";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SMALL, writeGguf } from "../../../packages/models/tests/support/gguf_fixture.js";
import { type ConfigApiDeps, createConfigApi } from "../src/config_api.js";
import { REVIEW_THINKING_TOKENS, type ReviewInput, reviewCard } from "../src/learning/review.js";
import { rolePromptVersion } from "../src/prompt_versions.js";
import { startDashboardServer } from "../src/server.js";
import { routePermissions } from "../src/team/access.js";
import { pageWriteHeaders } from "./page_headers.js";

// C3-3 over HTTP: a role's settings per model (models NEW-models-21,
// MD-N21-1..11; dashboard NEW-dashboard-27; PM_CONTRACT §3 *A role's
// settings*), the Models section's fixes (FINDINGS CFG-02, -03, -04, -14),
// the recommended set's size and licences before the yes (MD-N18-3), the
// engine card's routes mounted, and R3c's reasoning reaching the Reviewer.
// A real ledger, real files and a real HTTP server; no model is loaded and
// nothing is downloaded.

// biome-ignore lint/suspicious/noExplicitAny: JSON read back from the API, checked field by field
type Json = any;

const GB = 1e9;
const GiB = 1024 ** 3;
const HOST = "host-test";

function reading(headroomGb = 16, totalGiB = 96): MemoryReading {
  return {
    at: 0,
    gpuWiredLimitBytes: 64 * GiB,
    metalInUseBytes: 64 * GiB - 1 * GiB - headroomGb * GB,
    totalBytes: totalGiB * GiB,
    wiredBytes: 0,
    anonymousBytes: 0,
    compressorBytes: 0,
    swapUsedBytes: 0,
    processes: [],
  };
}

interface Fixture {
  dir: string;
  db: DatabaseSync;
  log: EventLog;
  registry: ModelRegistry;
  models: string;
  base: string;
  server: Server;
  api: ReturnType<typeof createConfigApi>;
}
let f: Fixture;

async function listen(s: Server): Promise<string> {
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const a = s.address();
  return `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
}

async function setup(over: Partial<ConfigApiDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sek-config-settings-"));
  const db = new DatabaseSync(join(dir, "events.db"));
  initSchema(db);
  const log = new EventLog(db);
  const registry = new ModelRegistry(join(dir, "models.json"));
  const userConfig = join(dir, "user", "config.toml");
  mkdirSync(join(dir, "user"), { recursive: true });
  writeFileSync(userConfig, '[team]\nmode = "solo"\n\n[network]\nmode = "offline"\n');
  const models = join(dir, "models");
  writeGguf(join(models, "tiny-Q4_K_M.gguf"), { ...SMALL, name: "Tiny Llama", padBytes: 2048 });
  // KV of about 15.6 GB at 16K tokens: over the reference host's 15 GB seed ceiling.
  writeGguf(join(models, "deep-Q4_K_M.gguf"), {
    ...SMALL,
    name: "Deep",
    blockCount: 440,
    headCountKv: 8,
    headCount: 32,
    embeddingLength: 4096,
  });
  const api = createConfigApi({
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
    principalOf: () => "p_owner",
    userConfigPath: userConfig,
    env: {},
    registry,
    headroomProbe: new FakeHeadroomProbe(reading()),
    host: () => HOST,
    hashCachePath: join(dir, "hashes.json"),
    volume: () => "internal",
    freeBytes: () => 500 * GB,
    referenceHost: () => false,
    ...over,
  });
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const [url = "/", search = ""] = (req.url ?? "/").split("?");
    if (!(await api.handle(req, res, url, new URLSearchParams(search)))) {
      res.writeHead(404);
      res.end();
    }
  });
  await teardown();
  f = { dir, db, log, registry, models, base: await listen(server), server, api };
  open = true;
}

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${f.base}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-sekhemet-action": "1" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as Record<string, Json> };
}

const changes = async () =>
  (await f.log.getEventsByTypes(["models/settings_changed"])).map((e) => e.payload as Json);

const value = (body: Json, key: string) => (body.values as Json[]).find((v: Json) => v.key === key);

function qualified(
  model: string,
  role: "worker" | "reviewer",
  over = {},
): QualificationCombination {
  const c: QualificationCombination = {
    engine: "llama.cpp b10809",
    modelBuild: "sampled-sha256:1111",
    host: HOST,
    settings: {
      contextTokens: role === "worker" ? 16384 : 12288,
      kvType: "q8_0",
      speculative: "off",
      prefixCaching: true,
      parallelSlots: 1,
      chatTemplate: "tmpl",
      contextVersion: rolePromptVersion(role),
      ...(role === "worker" ? {} : { role }),
      ...over,
    },
  };
  f.registry.recordCombinationQualification(model, c, {
    suiteVersion: "q1.2",
    passRate: 1,
    status: "qualified",
    toolCallChecks: true,
  });
  return c;
}

const addFolder = () => call("POST", "/api/config/models/folders", { path: f.models });

let open = false;
async function teardown() {
  if (!open) return;
  open = false;
  f.api.close();
  await new Promise<void>((r) => f.server.close(() => r()));
  f.db.close();
  rmSync(f.dir, { recursive: true, force: true });
}

describe("a role's settings over HTTP (MD-N21-1, -4, -5; DB-N27-2)", () => {
  beforeEach(async () => setup());
  afterEach(teardown);

  it("serves every value graded with its source, the fields by tab, the fit at a context, and records nothing", async () => {
    await addFolder();
    f.registry.upsert("tiny-llama", { family: "qwen", toolArm: "arm_b_json" });
    const r = await call(
      "GET",
      "/api/config/roles/reviewer/settings?model=tiny-llama&context=8192",
    );
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ role: "reviewer", model: "tiny-llama" });
    expect(value(r.body, "temperature")).toMatchObject({ value: 0.7, grade: "card" });
    expect(value(r.body, "toolArm")).toMatchObject({ value: "arm_b_json", grade: "measured" });
    expect(value(r.body, "contextTokens")).toMatchObject({ value: 12288, grade: "default" });
    expect(r.body.fields.map((x: Json) => x.tab)).toContain("harness");
    expect(r.body.verification.state).toBe("not_verified");
    expect(r.body.fit).toMatchObject({ fits: "yes", contextTokens: 8192 });
    expect(r.body.fit.reason).toMatch(/GB of .* GB usable/);
    expect(await changes()).toEqual([]);
  });

  it("saves a person's values graded Set by them, recorded with the keys and the principal", async () => {
    await addFolder();
    const r = await call("PUT", "/api/config/roles/reviewer/settings", {
      model: "tiny-llama",
      values: { temperature: 0, reasoningLevel: "medium", reasoningCapTokens: 6144 },
    });
    expect(r.status).toBe(200);
    expect(value(r.body, "temperature")).toMatchObject({ value: 0, grade: "set", by: "p_owner" });
    expect(f.registry.roleSettings("tiny-llama", "reviewer")?.values).toEqual({
      temperature: 0,
      reasoningLevel: "medium",
      reasoningCapTokens: 6144,
    });
    expect(await changes()).toEqual([
      {
        model: "tiny-llama",
        role: "reviewer",
        action: "set",
        keys: ["temperature", "reasoningLevel", "reasoningCapTokens"],
        needsVerifying: false,
        principal: "p_owner",
      },
    ]);
  });

  it("refuses 4-bit KV, a value out of range, an unknown key and a context that does not fit, recording nothing", async () => {
    await addFolder();
    for (const [values, refused] of [
      [{ kvType: "q4_0" }, "kv"],
      [{ temperature: 9 }, "range"],
      [{ warmth: 1 }, "unknown"],
      [{ reasoningFloor: "high" }, "readonly"],
    ] as const) {
      const r = await call("PUT", "/api/config/roles/worker/settings", {
        model: "tiny-llama",
        values,
      });
      expect({ values, status: r.status, refused: r.body.refused }).toEqual({
        values,
        status: 400,
        refused,
      });
      expect(r.body.error).toBeTruthy();
    }
    // 131,072 tokens of Deep's KV is far beyond this machine: refused, the shortfall named.
    const fit = await call("PUT", "/api/config/roles/worker/settings", {
      model: "deep",
      values: { contextTokens: 131072 },
    });
    expect({ status: fit.status, refused: fit.body.refused }).toEqual({
      status: 400,
      refused: "fit",
    });
    expect(fit.body.error).toMatch(/^Needs \d/);
    expect(f.registry.roleSettings("tiny-llama", "worker")).toBeUndefined();
    expect(f.registry.roleSettings("deep", "worker")).toBeUndefined();
    expect(await changes()).toEqual([]);
  });

  it("gives hints beside a value without refusing it", async () => {
    await addFolder();
    const r = await call("PUT", "/api/config/roles/worker/settings", {
      model: "tiny-llama",
      values: { temperature: 1.3, kvType: "q5_1" },
    });
    expect(r.status).toBe(200);
    expect(r.body.hints.map((h: Json) => h.key)).toEqual(["temperature", "kvType"]);
  });

  it("MD-N21-3: an element changed marks the role Needs verifying, named, until it verifies; Reset restores it", async () => {
    await addFolder();
    qualified("tiny-llama", "reviewer");
    f.registry.upsert("tiny-llama", { family: "llama" });
    f.registry.upsert("w", { family: "qwen" });
    qualified("w", "worker");
    await call("PUT", "/api/config/roles/worker", { model: "w" });
    expect((await call("PUT", "/api/config/roles/reviewer", { model: "tiny-llama" })).status).toBe(
      200,
    );
    let roles = await call("GET", "/api/config/roles");
    let reviewer = roles.body.roles.find((x: Json) => x.role === "reviewer");
    expect(reviewer.verification.state).toBe("verified");
    expect(reviewer.checks).toEqual(
      expect.arrayContaining(["Verified on this machine", "Review model from another family"]),
    );

    const put = await call("PUT", "/api/config/roles/reviewer/settings", {
      model: "tiny-llama",
      values: { presencePenalty: 1.5, seed: 4 },
    });
    expect(put.body.verification).toMatchObject({
      state: "needs_verifying",
      changed: ["repeat and presence penalties"],
    });
    expect((await changes()).at(-1)).toMatchObject({ needsVerifying: true });
    roles = await call("GET", "/api/config/roles");
    reviewer = roles.body.roles.find((x: Json) => x.role === "reviewer");
    expect(reviewer.qualified).toBe(false);
    expect(reviewer.checks).toContain("Needs verifying: repeat and presence penalties changed");

    // A value that is not an element changes nothing about verification.
    const seedOnly = await call("POST", "/api/config/roles/reviewer/settings/reset", {
      model: "tiny-llama",
      keys: ["presencePenalty"],
    });
    expect(seedOnly.body.verification.state).toBe("verified");
    expect(value(seedOnly.body, "seed")).toMatchObject({ value: 4, grade: "set" });
    expect((await changes()).at(-1)).toMatchObject({ action: "reset", keys: ["presencePenalty"] });
  });

  it("exports only a person's values and imports a file of its own format into another role, with a hint", async () => {
    await addFolder();
    await call("PUT", "/api/config/roles/reviewer/settings", {
      model: "tiny-llama",
      values: { reasoningLevel: "medium" },
    });
    const ex = await call("GET", "/api/config/roles/reviewer/settings/export?model=tiny-llama");
    expect(ex.body).toEqual({
      format: "sekhemet-role-settings/1",
      model: "tiny-llama",
      role: "reviewer",
      values: { reasoningLevel: "medium" },
    });
    const im = await call("POST", "/api/config/roles/planner/settings/import", {
      model: "deep",
      file: ex.body,
    });
    expect(im.status).toBe(200);
    expect(value(im.body, "reasoningLevel")).toMatchObject({ value: "medium", grade: "set" });
    expect(im.body.hints.map((h: Json) => h.text).join(" ")).toMatch(/made for tiny-llama/);
    expect((await changes()).at(-1)).toMatchObject({ action: "import", role: "planner" });
    const bad = await call("POST", "/api/config/roles/planner/settings/import", {
      model: "deep",
      file: { format: "lmstudio/1", values: {} },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/sekhemet-role-settings\/1/);
  });

  it("a Balanced preset resets the preset's values; Careful sets them", async () => {
    await addFolder();
    const careful = await call("PUT", "/api/config/roles/worker/settings", {
      model: "tiny-llama",
      preset: "careful",
      values: {},
    });
    expect(value(careful.body, "reasoningLevel")).toMatchObject({ value: "medium", grade: "set" });
    expect(careful.body.preset).toBe("careful");
    const balanced = await call("PUT", "/api/config/roles/worker/settings", {
      model: "tiny-llama",
      preset: "balanced",
      values: {},
    });
    expect(value(balanced.body, "reasoningLevel").grade).toBe("default");
  });

  it("needs config.manage for every change, and none to read (DB-N27-5)", () => {
    for (const [method, path] of [
      ["PUT", "/api/config/roles/reviewer/settings"],
      ["POST", "/api/config/roles/reviewer/settings/reset"],
      ["POST", "/api/config/roles/reviewer/settings/import"],
    ] as const)
      expect(routePermissions(method, path, {})).toEqual({ permissions: ["config.manage"] });
    expect(
      routePermissions("GET", "/api/config/roles/reviewer/settings", undefined),
    ).toBeUndefined();
  });
});

describe("the Models section's fixes", () => {
  afterEach(teardown);
  it("CFG-02 (MD-N21-8): a model that fits this machine fits while reclaimable cache fills the momentary memory, never a negative amount", async () => {
    await setup({ headroomProbe: new FakeHeadroomProbe(reading(-0.3)) });
    const r = await addFolder();
    const tiny = (r.body.models as Json[]).find((m) => m.name === "Tiny Llama");
    expect(tiny.fits.worker).toBe("yes");
    for (const m of r.body.models as Json[])
      for (const reason of Object.values(m.fitReason)) expect(reason).not.toMatch(/of -/);
  });

  it("CFG-14 (MD-N21-9): the seed ceiling only on the reference host; a recorded ceiling on any", async () => {
    await setup({ referenceHost: () => false });
    let deep = ((await addFolder()).body.models as Json[]).find((m) => m.name === "Deep");
    expect(deep.fits.worker).toBe("yes");

    await setup({ referenceHost: () => true });
    deep = ((await addFolder()).body.models as Json[]).find((m) => m.name === "Deep");
    expect(deep.fits.worker).toBe("no");
    expect(deep.fitReason.worker).toMatch(/GPU ceiling/);

    await setup({ referenceHost: () => false });
    await f.log.append({
      actor: "harness",
      type: "model/gpu_ceiling",
      payload: { basis: "calibrated", bytes: 1_000_000 },
    });
    const tiny = ((await addFolder()).body.models as Json[]).find((m) => m.name === "Tiny Llama");
    expect(tiny.fits.worker).toBe("no");
    expect(tiny.fitReason.worker).toMatch(/GPU ceiling/);
  });

  it("CFG-03 (MD-N21-10): with no models there is no combination, and nothing meets the floors", async () => {
    await setup();
    const r = await call("GET", "/api/config/combinations");
    expect(r.body.combinations).toEqual([]);
  });

  it("CFG-04 (MD-N21-11): assigning a Coding model on the page records its M0 as owed", async () => {
    await setup();
    await addFolder();
    f.registry.upsert("tiny-llama", { family: "llama" });
    qualified("tiny-llama", "worker");
    expect((await call("PUT", "/api/config/roles/worker", { model: "tiny-llama" })).status).toBe(
      200,
    );
    const pending = (await f.log.getEventsByTypes(["m0/pending"])).map((e) => e.payload as Json);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      worker: "tiny-llama",
      reason: "assigned as the Coding model on this machine",
    });
    expect(pending[0].combination).toMatch(/llama\.cpp b10809/);
    // Another role records none.
    f.registry.upsert("other", { family: "qwen" });
    qualified("other", "reviewer");
    await call("PUT", "/api/config/roles/reviewer", { model: "other" });
    expect(await f.log.getEventsByTypes(["m0/pending"])).toHaveLength(1);
  });

  it("MD-N18-3: on a clean machine the suggestion is the shipped set, its total size and each licence before the yes", async () => {
    // Room for the shipped models; no folder, so nothing is present.
    await setup({ headroomProbe: new FakeHeadroomProbe(reading(64, 96)) });
    const r = await call("GET", "/api/config/recommended");
    expect(r.status).toBe(200);
    expect(r.body.combination).toMatchObject({
      worker: "nail-mtp",
      planner: "qwen3.8-27b-gsq-rco",
      researcher: "apodex-1.1-mini",
    });
    // The Review role is unfilled in the shipped set; it says why.
    expect(r.body.combination.reviewer).toBeUndefined();
    const downloads = r.body.downloads as Json[];
    expect(downloads.map((d) => d.model).sort()).toEqual(
      ["apodex-1.1-mini", "nail-mtp", "qwen3.8-27b-gsq-rco"].sort(),
    );
    for (const d of downloads) {
      expect(d.sizeBytes).toBeGreaterThan(1e9);
      expect(d.license).toBe("Apache-2.0");
      expect(d.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(r.body.totalBytes).toBe(14_069_275_872 + 12_120_016_960 + 16_022_990_656);
    expect(r.body.licenses).toEqual(["Apache-2.0"]);
    // Offline by default: each download names the setting before the press.
    for (const d of downloads) expect(d.blockedBy).toMatch(/\[network\] mode|offline/);
  });

  it("MD-N18-3: the total counts only what is still to download", async () => {
    await setup({ headroomProbe: new FakeHeadroomProbe(reading(64, 96)) });
    const have = join(f.dir, "nail.gguf");
    writeFileSync(have, "x");
    f.registry.recordWeights("nail-mtp", {
      path: have,
      volume: "internal",
      sha256: "a".repeat(64),
    });
    const r = await call("GET", "/api/config/recommended");
    expect((r.body.downloads as Json[]).map((d) => d.model)).not.toContain("nail-mtp");
    expect(r.body.totalBytes).toBe(
      (r.body.downloads as Json[]).reduce((n: number, d: Json) => n + d.sizeBytes, 0),
    );
    expect(r.body.totalBytes).toBe(12_120_016_960 + 16_022_990_656);
  });

  it("mounts the engine card's routes: the engine's state reads, and a download needs the yes", async () => {
    await setup();
    const g = await call("GET", "/api/config/engine");
    expect(g.status).toBe(200);
    expect(typeof g.body.floor).toBe("number");
    expect(typeof g.body.line).toBe("string");
    const p = await call("POST", "/api/config/engine/get", {});
    expect([400, 409]).toContain(p.status);
    expect(await f.log.getEventsByTypes(["engine/downloaded"])).toEqual([]);
  });

  it("CFG-10, §2.16 (B1-C3 review): with downloads off, the engine's offer names why before the press, and a press fetches nothing", async () => {
    await setup();
    const g = await call("GET", "/api/config/engine");
    expect(g.status).toBe(200);
    expect(g.body.offer).toBeDefined();
    expect(g.body.refusal).toMatch(/^Downloads are off: Sekhemet is offline by default\./);
    // Names the hosts an allowlist would need, and the way round it.
    expect(g.body.refusal).toMatch(/github\.com/);
    expect(g.body.refusal).toMatch(/release-assets\.githubusercontent\.com/);
    expect(g.body.refusal).toMatch(/install llama\.cpp yourself/);
    const p = await call("POST", "/api/config/engine/get", { confirm: true });
    expect(p.status).toBe(409);
    expect(p.body.error).toBe(g.body.refusal);
    expect(await f.log.getEventsByTypes(["engine/downloaded", "harness/egress"])).toEqual([]);
  });

  it("names each role's Team engine check in words", async () => {
    await setup({
      teamEngines: async () => ({
        engines: [
          {
            service: "engine-coding",
            roles: ["coding"],
            modelId: "nail-mtp",
            port: 8098,
            state: "ok",
          },
          {
            service: "engine-planning",
            roles: ["planning"],
            modelId: "qwen3.8-27b-gsq-rco",
            port: 8099,
            state: "no-engine",
            reason: "no engine answers on port 8099",
          },
        ],
        unfilled: [],
        footprint: { totalBytes: 0 },
        lines: [],
      }),
    });
    const r = await call("GET", "/api/config/roles");
    const by = Object.fromEntries((r.body.roles as Json[]).map((x) => [x.role, x]));
    expect(by.worker.engine).toMatchObject({ service: "engine-coding", state: "ok" });
    expect(by.worker.engine.line).toMatch(/answering on port 8098/);
    expect(by.planner.engine).toMatchObject({ state: "no-engine" });
    expect(by.planner.engine.line).toMatch(/no engine answers on port 8099/);
    expect(by.reviewer.engine).toBeUndefined();
  });

  it("DB-N27-6 (CFG-13): a model's details are the chosen role's, never the Coding model's by default", async () => {
    await setup();
    const r = await addFolder();
    const tiny = (r.body.models as Json[]).find((m) => m.name === "Tiny Llama");
    const d = await call("GET", `/api/config/models/${tiny.id}?role=reviewer`);
    expect(d.body.role).toBe("reviewer");
    expect(d.body.memory.contextTokens).toBe(12288);
  });
});

describe("the setup card's suggestion (B1-C3 review: DB-N27-1, rule 3)", () => {
  afterEach(teardown);
  // Too little room for the shipped set, so only the folder's models are candidates.
  const small = () => setup({ headroomProbe: new FakeHeadroomProbe(reading(4)) });
  const role = (body: Json, r: string) => (body.roles as Json[]).find((x) => x.role === r);

  it("with no Coding model assigned, the Review model is judged against the recommended one's family", async () => {
    await small();
    await addFolder();
    const roles = (await call("GET", "/api/config/roles")).body;
    const worker = role(roles, "worker").recommendation?.model;
    expect(worker).toBe("tiny-llama");
    // Every model in the folder is of the recommended Coding model's family (llama).
    expect(role(roles, "reviewer").recommendation).toBeUndefined();
    const plan = (await call("GET", "/api/config/recommended")).body;
    expect(plan.combination.worker).toBe("tiny-llama");
    expect(plan.combination.reviewer).toBeUndefined();
    expect((plan.unfilled as Json[]).map((u) => u.role)).toContain("reviewer");
  });

  it("every row states its checks in words, for the recommended model when none is assigned", async () => {
    await small();
    await addFolder();
    const roles = (await call("GET", "/api/config/roles")).body;
    expect(role(roles, "worker").model).toBeUndefined();
    expect(role(roles, "worker").checks).toEqual([
      "Fits in memory",
      "Not verified on this machine yet",
    ]);
    expect(role(roles, "planner").checks.length).toBeGreaterThan(0);
  });

  it("a Review model that shares the Coding model's family says so as a failing check", async () => {
    await small();
    await addFolder();
    qualified("tiny-llama", "worker");
    expect((await call("PUT", "/api/config/roles/worker", { model: "tiny-llama" })).status).toBe(
      200,
    );
    f.registry.upsert("deep", { family: "qwen" });
    qualified("deep", "reviewer");
    // Assigned while it was another family's; then its family is corrected to the Coding model's.
    assignRole(f.registry, {
      role: "reviewer",
      model: "deep",
      scope: "personal",
      by: "p_owner",
      host: HOST,
      qualification: "qualified",
    });
    f.registry.upsert("deep", { family: "llama" });
    const reviewer = role((await call("GET", "/api/config/roles")).body, "reviewer");
    expect(reviewer.model).toBe("deep");
    expect(reviewer.checks).toContain("Not from another family: the Coding model's is llama too");
  });

  it("Keep: the kept role is not replaced by Apply suggestion, survives a reload, and Change lets the suggestion back", async () => {
    await small();
    writeGguf(join(f.models, "small-Q4_K_M.gguf"), { ...SMALL, name: "Small Two", padBytes: 0 });
    await addFolder();
    qualified("tiny-llama", "worker");
    qualified("small-two", "worker");
    expect((await call("PUT", "/api/config/roles/worker", { model: "tiny-llama" })).status).toBe(
      200,
    );
    let roles = (await call("GET", "/api/config/roles")).body;
    expect(role(roles, "worker").recommendation.model).toBe("small-two");
    expect(role(roles, "worker").kept).toBeFalsy();

    expect((await call("POST", "/api/config/roles/worker/keep", { kept: true })).status).toBe(200);
    // A reload reads it back from the ledger.
    roles = (await call("GET", "/api/config/roles")).body;
    expect(role(roles, "worker").kept).toBe(true);
    const plan = (await call("GET", "/api/config/recommended")).body;
    expect(plan.combination.worker).toBe("tiny-llama");
    expect(plan.kept).toEqual([{ role: "worker", model: "tiny-llama" }]);
    const kept = (await f.log.getEventsByTypes(["models/suggestion_kept"])).map(
      (e) => e.payload as Json,
    );
    expect(kept).toEqual([
      { role: "worker", model: "tiny-llama", kept: true, host: HOST, principal: "p_owner" },
    ]);

    // Apply suggestion: the kept role keeps its model.
    const run = await call("POST", "/api/config/recommended", { confirm: true, downloads: [] });
    expect(run.status).toBe(202);
    for (let i = 0; i < 100; i++) {
      const last = (await call("GET", "/api/config/recommended")).body.last;
      if (last?.state === "done") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const last = (await call("GET", "/api/config/recommended")).body.last;
    expect(last.state).toBe("done");
    expect((last.assigned as Json[]).map((a) => a.role)).not.toContain("worker");
    expect(role((await call("GET", "/api/config/roles")).body, "worker").model).toBe("tiny-llama");

    // Change takes the keep back: the suggestion returns.
    expect((await call("POST", "/api/config/roles/worker/keep", { kept: false })).status).toBe(200);
    expect((await call("GET", "/api/config/recommended")).body.combination.worker).toBe(
      "small-two",
    );
  });
});

describe("R3c (MD-N21-7): the Reviewer's reasoning comes from the Review role's settings", () => {
  const usage = { promptTokens: 1, completionTokens: 1, durationMs: 1 };
  const input: ReviewInput = {
    card: {
      id: "c1",
      title: "Ledger",
      spec: "Store entries.",
      acceptanceCriteria: ["append adds one entry"],
      criterionIds: ["AC-1"],
    },
    diff: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n",
    stagedTests: [],
    checks: [],
    assumptions: [],
    preferences: [],
    rules: [],
  };
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sek-r3c-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("asks gpt-oss-20b for medium reasoning at its cap when the Review role sets them, else none at the high cap", async () => {
    const registry = new ModelRegistry(join(dir, "models.json"));
    const reply = { text: JSON.stringify({ criteria: [] }), toolCalls: [], usage };
    const window = { contextTokens: 32768, maxTokens: 2048 };
    const plain = Object.assign(new MockInferenceAdapter("gpt-oss-20b", [reply]), {
      registry,
      contextWindow: window,
    });
    await reviewCard(plain, input);
    expect(plain.callHistory[0]).toMatchObject({
      reasoning: "off",
      reasoningBudgetTokens: REVIEW_THINKING_TOKENS,
    });
    registry.setRoleSettings(
      "gpt-oss-20b",
      "reviewer",
      { reasoningLevel: "medium", reasoningCapTokens: 6144 },
      "p_owner",
    );
    const tuned = Object.assign(new MockInferenceAdapter("gpt-oss-20b", [reply]), {
      registry,
      contextWindow: window,
    });
    await reviewCard(tuned, input);
    expect(tuned.callHistory[0]).toMatchObject({
      reasoning: "medium",
      reasoningBudgetTokens: 6144,
    });
    // Another role's settings are not the Reviewer's.
    registry.resetRoleSettings("gpt-oss-20b", "reviewer");
    registry.setRoleSettings("gpt-oss-20b", "worker", { reasoningLevel: "high" }, "p_owner");
    const other = Object.assign(new MockInferenceAdapter("gpt-oss-20b", [reply]), {
      registry,
      contextWindow: window,
    });
    await reviewCard(other, input);
    expect(other.callHistory[0]).toMatchObject({ reasoning: "off" });
  });
});

describe("in the Team setup a change is an Admin's (MD-N21-5, DB-N27-5)", () => {
  let repo: string;
  let db: DatabaseSync;
  let server: { port: number; close: () => Promise<void> } | undefined;
  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), "sek-settings-team-"));
    // This server's registry is this test's own, never the run's shared one.
    vi.stubEnv("SEKHEMET_CONFIG_DIR", join(repo, "cfg"));
    vi.stubEnv("SEKHEMET_MODEL_REGISTRY", join(repo, "models.json"));
    db = new DatabaseSync(join(repo, "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    for (const [principal, level] of [
      ["p_admin", "admin"],
      ["p_member", "member"],
    ] as const)
      log.appendNow({
        actor: "system",
        type: "member/joined",
        principal,
        payload: { principal, level, via: "invite", pending: false },
      });
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
      requester: (req) => {
        const h = req.headers["x-test-principal"];
        return typeof h === "string" && h ? h : undefined;
      },
    });
  });
  afterEach(async () => {
    await server?.close();
    vi.unstubAllEnvs();
    db.close();
    rmSync(repo, { recursive: true, force: true });
  });

  const put = async (who: string) => {
    const base = `http://127.0.0.1:${server?.port}`;
    const res = await fetch(`${base}/api/config/roles/reviewer/settings`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        ...(await pageWriteHeaders(base)),
        "X-Test-Principal": who,
      },
      body: JSON.stringify({ model: "some-model", values: { temperature: 0 } }),
    });
    return { status: res.status, body: (await res.json()) as Json };
  };

  it("refuses a Member with 403 and the level note, and saves an Admin's", async () => {
    const member = await put("p_member");
    expect(member.status).toBe(403);
    expect(JSON.stringify(member.body)).toMatch(/Admin/);
    const admin = await put("p_admin");
    expect(admin.status).toBe(200);
    expect(value(admin.body, "temperature")).toMatchObject({ value: 0, grade: "set" });
  });
});
