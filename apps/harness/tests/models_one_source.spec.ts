import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventLog, initSchema } from "@sekhemet/kernel";
import {
  FakeHeadroomProbe,
  type MemoryReading,
  ModelRegistry,
  hostFingerprintHash,
} from "@sekhemet/models";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SMALL, writeGguf } from "../../../packages/models/tests/support/gguf_fixture.js";
import { createConfigApi } from "../src/config_api.js";
import { modelRoster } from "../src/pm_api.js";
import { effectiveRoleModels } from "../src/role_models.js";

/**
 * Loop wave 7 B (sweep 4, models and measurement): the CLI, doctor,
 * Configuration and Machine named different models for the same roles —
 * Machine read the shipped roster, Configuration only a person's
 * assignments, the CLI `role_models.ts`. One effective-role source now: each
 * surface names the model `run` and the queue would use, with where it comes
 * from, and reading it writes nothing (B1). With no run nothing is resident
 * or swapped out (B2). The Review model is never offered, nor assigned, of
 * the family of the Coding model the harness would use (B3, RG-P8-10).
 */

// biome-ignore lint/suspicious/noExplicitAny: JSON read back from the API, checked field by field
type Json = any;

const GB = 1e9;
const GiB = 1024 ** 3;
const HOST = "host-one-source";

function reading(): MemoryReading {
  return {
    at: 0,
    gpuWiredLimitBytes: 64 * GiB,
    metalInUseBytes: 64 * GiB - 1 * GiB - 16 * GB,
    totalBytes: 96 * GiB,
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
  registry: ModelRegistry;
  registryPath: string;
  models: string;
  api: ReturnType<typeof createConfigApi>;
  base: string;
  server: Server;
}
let f: Fixture;

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), "sek-one-source-"));
  mkdirSync(join(dir, ".sekhemet"), { recursive: true });
  const db = new DatabaseSync(join(dir, "events.db"));
  initSchema(db);
  const log = new EventLog(db);
  const registryPath = join(dir, "models.json");
  const registry = new ModelRegistry(registryPath);
  const userConfig = join(dir, "user", "config.toml");
  mkdirSync(join(dir, "user"), { recursive: true });
  writeFileSync(userConfig, '[team]\nmode = "solo"\n\n[network]\nmode = "offline"\n');
  const models = join(dir, "models");
  // A Qwen-family file, the Coding default's family (nail-mtp is qwen).
  writeGguf(join(models, "qwen-small-Q4_K_M.gguf"), {
    ...SMALL,
    architecture: "qwen2",
    name: "Qwen Small",
    padBytes: 2048,
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
    hub: "http://127.0.0.1:9",
    internalDir: join(dir, "internal"),
    hashCachePath: join(dir, "hashes.json"),
    volume: () => "internal",
    freeBytes: () => 500 * GB,
    bandwidth: { value: 120 * GB, grade: "measured" },
  });
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const [url = "/", search = ""] = (req.url ?? "/").split("?");
    if (!(await api.handle(req, res, url, new URLSearchParams(search)))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const a = server.address();
  const base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
  f = { dir, db, registry, registryPath, models, api, base, server };
});

afterEach(async () => {
  f.api.close();
  await new Promise<void>((r) => f.server.close(() => r()));
  f.db.close();
  rmSync(f.dir, { recursive: true, force: true });
});

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${f.base}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-sekhemet-action": "1" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as Record<string, Json> };
}

const snapshot = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : undefined);

describe("B1: one effective-role source, read without a write", () => {
  it("effectiveRoleModels leaves a fresh registry as it was (no Review default recorded)", () => {
    const before = snapshot(f.registryPath);
    const roles = effectiveRoleModels(f.dir, { registry: f.registry, host: HOST, env: {} });
    expect(roles.map((r) => r.role)).toEqual(["worker", "planner", "reviewer", "researcher"]);
    expect(snapshot(f.registryPath)).toBe(before);
    expect(f.registry.roleAssignments(HOST)).toEqual([]);
  });

  it("Configuration names each role's model as the CLI does, with where it comes from", async () => {
    await call("POST", "/api/config/models/folders", { path: f.models });
    const cli = effectiveRoleModels(f.dir, { registry: f.registry, host: HOST, env: {} });
    const r = await call("GET", "/api/config/roles");
    const rows = r.body.roles as Json[];
    for (const want of cli) {
      const row = rows.find((x) => x.role === want.role);
      expect(row?.effective).toEqual({
        ...(want.model ? { model: want.model } : {}),
        source: want.source,
        from: want.from,
        // An Ollama tag's store is not read here, so its presence is not claimed.
        ...(want.model && !want.model.includes(":") ? { present: expect.any(Boolean) } : {}),
      });
    }
    // Nothing is assigned: the Coding model is the default, not in a folder here.
    expect(rows[0].model).toBeUndefined();
    expect(rows[0].effective).toMatchObject({ source: "default", present: false });
    // A read writes nothing.
    expect(f.registry.roleAssignments(HOST)).toEqual([]);
  });

  it("Machine's roster names the same models as the CLI when no run holds the runner", () => {
    const cli = effectiveRoleModels(f.dir, { host: HOST, registry: new ModelRegistry() });
    const roster = modelRoster(f.dir);
    expect(roster.running).toBe(false);
    const byRole = new Map(roster.roles.map((r) => [r.role === "manager" ? "planner" : r.role, r]));
    for (const want of cli) {
      expect(byRole.get(want.role)?.model).toBe(want.model);
      expect(byRole.get(want.role)?.from).toBe(want.from);
    }
    // B2: no run, so nothing is resident or swapped out.
    for (const r of roster.roles) expect(r.state).toBe(r.model ? "not_in_use" : "unconfigured");
  });
});

describe("B1: a read that verifies the Review model writes nothing (MD-N4-5b)", () => {
  it("GET /api/config/roles and Machine's roster leave a host-matched registry byte for byte as it was", async () => {
    // A Coding model of a known family and a Planning model of another, on the
    // host each surface reads (the server's, and this machine's for Machine),
    // so the Review role resolves to the Planning model and is described.
    for (const host of [HOST, hostFingerprintHash()]) {
      for (const [role, model] of [
        ["worker", "qwen3-coder:30b"],
        ["planner", "gemma-x:latest"],
      ] as const) {
        f.registry.recordRoleAssignment(host, {
          role,
          model,
          scope: "personal",
          by: "person",
          date: "2026-10-11T00:00:00.000Z",
        });
      }
    }
    const before = snapshot(f.registryPath);
    const roles = (await call("GET", "/api/config/roles")).body.roles as Json[];
    expect(roles.find((x) => x.role === "planner")?.effective.model).toBe("gemma-x:latest");
    expect(snapshot(f.registryPath)).toBe(before);
    vi.stubEnv("SEKHEMET_MODEL_REGISTRY", f.registryPath);
    try {
      const roster = modelRoster(f.dir);
      expect(roster.roles.find((r) => r.role === "manager")?.model).toBe("gemma-x:latest");
    } finally {
      vi.unstubAllEnvs();
    }
    expect(snapshot(f.registryPath)).toBe(before);
  });
});

describe("B3: the Review model is of another family than the Coding model the harness would use", () => {
  it("names the Coding model's family on the Review row and refuses a model of it, even verified", async () => {
    // The Coding model the harness would use: config.toml's, nail-mtp (qwen), never assigned.
    writeFileSync(join(f.dir, ".sekhemet", "config.toml"), '[models]\nexecutor = "nail-mtp"\n');
    await call("POST", "/api/config/models/folders", { path: f.models });
    // Verified, so only the family rule can refuse it.
    f.registry.upsert("qwen-small", {
      family: "qwen",
      qualification: { suiteVersion: "q1", passRate: 1, date: "2026-10-11", status: "qualified" },
    });
    const roles = (await call("GET", "/api/config/roles")).body.roles as Json[];
    const reviewer = roles.find((x) => x.role === "reviewer");
    expect(roles[0].model).toBeUndefined();
    expect(roles[0].effective).toMatchObject({ model: "nail-mtp", source: "config" });
    expect(reviewer.codingFamily).toBe("qwen");
    const r = await call("PUT", "/api/config/roles/reviewer", { model: "qwen-small" });
    expect(r.status).toBe(409);
    expect(r.body.needs).toBe("other-family");
    expect(f.registry.roleAssignments(HOST)).toEqual([]);
  });
});

describe("B4: each row says which found models are verified for its role", () => {
  it("lists a role's verified models, so the row offers Verify before the press", async () => {
    await call("POST", "/api/config/models/folders", { path: f.models });
    let roles = (await call("GET", "/api/config/roles")).body.roles as Json[];
    expect(roles[0].verifiedModels).toEqual([]);
    f.registry.upsert("qwen-small", {
      family: "qwen",
      qualification: { suiteVersion: "q1", passRate: 1, date: "2026-10-11", status: "qualified" },
    });
    roles = (await call("GET", "/api/config/roles")).body.roles as Json[];
    expect(roles[0].verifiedModels).toContain("qwen-small");
  });
});

describe("B5: a found model carries the key the setup names it by", () => {
  it("the suggestion's model id is a found model's key", async () => {
    await call("POST", "/api/config/models/folders", { path: f.models });
    const found = (await call("GET", "/api/config/models")).body.models as Json[];
    const roles = (await call("GET", "/api/config/roles")).body.roles as Json[];
    const rec = roles[0].recommendation?.model;
    expect(rec).toBe("qwen-small");
    expect(found.map((m) => m.key)).toContain(rec);
  });
});

describe("B6: Benchmark's server words are the product's", () => {
  it("the protocols and an unbuilt role's reason use no internal words", async () => {
    const { EXTERNAL_PROTOCOL } = await import("../src/benchmark_cmd.js");
    const { TUNE_UNBUILT } = await import("../src/tune_settings.js");
    const words = [
      EXTERNAL_PROTOCOL.capstone,
      EXTERNAL_PROTOCOL.webbench,
      TUNE_UNBUILT("planner"),
    ].join("\n");
    expect(words).not.toMatch(/pass@|error@|non-zero|harness-and-model|benchmark set is not built/);
    expect(TUNE_UNBUILT("planner")).toBe(
      "Not measured yet: Sekhemet has no benchmark for the Planning model yet, so its settings can't be tuned here.",
    );
  });
});
