import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventLog, initSchema } from "@sekhemet/kernel";
import { FakeHeadroomProbe, type MemoryReading, ModelRegistry } from "@sekhemet/models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SMALL, writeGguf } from "../../../packages/models/tests/support/gguf_fixture.js";
import { resolveConfig } from "../src/config.js";
import { type ConfigApiDeps, createConfigApi, writeModelFolders } from "../src/config_api.js";
import { routePermissions } from "../src/team/access.js";

// B4.1 part (b): Configuration › Models over a real ledger, real files and a
// local fake Hugging Face server. No model is loaded; nothing is downloaded
// or copied until a person's POST asks for it.

// biome-ignore lint/suspicious/noExplicitAny: JSON read back from the API, checked field by field
type Json = any;

const GB = 1e9;
const GiB = 1024 ** 3;
const HOST = "host-test";

function reading(headroomGb = 16): MemoryReading {
  return {
    at: 0,
    gpuWiredLimitBytes: 64 * GiB,
    metalInUseBytes: 64 * GiB - 1 * GiB - headroomGb * GB,
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
  log: EventLog;
  registry: ModelRegistry;
  userConfig: string;
  models: string;
  api: ReturnType<typeof createConfigApi>;
  base: string;
  server: Server;
  frames: Record<string, unknown>[];
  hub: Server;
  hubBase: string;
  hubRequests: string[];
  weights: Buffer;
  weightsSha: string;
}

let f: Fixture;

async function listen(s: Server): Promise<string> {
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const a = s.address();
  return `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
}

async function setup(
  opts: {
    network?: string;
    volume?: (p: string) => "internal" | "external";
    free?: number;
    measureSpeed?: ConfigApiDeps["measureSpeed"];
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "sek-config-api-"));
  const db = new DatabaseSync(join(dir, "events.db"));
  initSchema(db);
  const log = new EventLog(db);
  const registry = new ModelRegistry(join(dir, "models.json"));
  const userConfig = join(dir, "user", "config.toml");
  mkdirSync(join(dir, "user"), { recursive: true });
  writeFileSync(
    userConfig,
    `[team]\nmode = "solo"\n\n[network]\nmode = "${opts.network ?? "offline"}"\n`,
  );
  const models = join(dir, "models");
  writeGguf(join(models, "tiny-Q4_K_M.gguf"), { ...SMALL, name: "Tiny Llama", padBytes: 2048 });
  // A header whose KV at 16K tokens is far beyond any machine: "Needs N GB".
  writeGguf(join(models, "giant-Q4_K_M.gguf"), {
    ...SMALL,
    name: "Giant",
    architecture: "gemma3",
    blockCount: 400,
    headCountKv: 64,
    headCount: 64,
    embeddingLength: 16384,
  });
  const weights = Buffer.alloc(200_000, 5);
  const weightsSha = createHash("sha256").update(weights).digest("hex");
  const hubRequests: string[] = [];
  const hub = createServer((req, res) => {
    hubRequests.push(`${req.method} ${req.url} ${req.headers.range ?? ""}`);
    if (req.url === "/org/r/resolve/main/w.gguf") {
      res.writeHead(200, { "content-length": weights.length });
      res.end(weights);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const hubBase = await listen(hub);
  const frames: Record<string, unknown>[] = [];
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
    emit: (d) => frames.push(d),
    userConfigPath: userConfig,
    env: {},
    registry,
    headroomProbe: new FakeHeadroomProbe(reading()),
    host: () => HOST,
    hub: hubBase,
    internalDir: join(dir, "internal"),
    hashCachePath: join(dir, "hashes.json"),
    volume: opts.volume ?? (() => "internal"),
    freeBytes: () => opts.free ?? 500 * GB,
    bandwidth: { value: 120 * GB, grade: "measured" },
    ...(opts.measureSpeed ? { measureSpeed: opts.measureSpeed } : {}),
  });
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const [url = "/", search = ""] = (req.url ?? "/").split("?");
    if (!(await api.handle(req, res, url, new URLSearchParams(search)))) {
      res.writeHead(404);
      res.end();
    }
  });
  const base = await listen(server);
  f = {
    dir,
    db,
    log,
    registry,
    userConfig,
    models,
    api,
    base,
    server,
    frames,
    hub,
    hubBase,
    hubRequests,
    weights,
    weightsSha,
  };
}

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${f.base}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-sekhemet-action": "1" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as Record<string, Json> };
}

const events = async (type: string) =>
  (await f.log.getEventsByTypes([type])).map((e) => ({
    payload: JSON.stringify(e.payload),
    private: e.private ? JSON.stringify(e.private) : null,
  }));

const waitFor = async (pred: () => boolean | Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

beforeEach(async () => setup());
afterEach(async () => {
  f.api.close();
  await new Promise<void>((r) => f.server.close(() => r()));
  await new Promise<void>((r) => f.hub.close(() => r()));
  f.db.close();
  rmSync(f.dir, { recursive: true, force: true });
});

describe("folders and the scan (DB-N6-3, MD-N12-1, MD-N13-1, SEC-N10-4)", () => {
  it("adds a folder to the user config, records it with the path private, and lists both models with their fit", async () => {
    const r = await call("POST", "/api/config/models/folders", { path: f.models });
    expect(r.status).toBe(200);
    expect(
      resolveConfig({ repoPath: f.dir, userConfigPath: f.userConfig }).config.models.folders,
    ).toEqual([{ path: f.models, includeSubfolders: false }]);
    // The rest of the user config is kept.
    expect(readFileSync(f.userConfig, "utf8")).toMatch(/\[network\]\nmode = "offline"/);
    const byName = new Map((r.body.models as Json[]).map((m) => [m.name, m]));
    expect(byName.get("Tiny Llama")).toMatchObject({
      quantisation: "Q4_K_M",
      contextLength: 32768,
    });
    expect(byName.get("Tiny Llama")?.fits.worker).toBe("yes");
    expect(byName.get("Tiny Llama")?.fitReason.worker).toMatch(/GB of .* GB usable/);
    expect(byName.get("Giant")?.fits.worker).toBe("no");
    expect(byName.get("Giant")?.fitReason.worker).toMatch(/^Needs \d/);
    expect(r.body.folders).toEqual([
      {
        path: f.models,
        source: "config",
        includeSubfolders: false,
        readable: true,
        writable: true,
        modelCount: 2,
      },
    ]);
    const added = await events("models/folder_added");
    expect(added).toHaveLength(1);
    expect(JSON.parse(added[0]?.payload ?? "{}")).toEqual({
      principal: "p_owner",
      includeSubfolders: false,
    });
    expect(JSON.parse(added[0]?.private ?? "{}")).toEqual({ path: f.models });
    const scanned = (await events("models/scanned")).at(-1);
    expect(JSON.parse(scanned?.payload ?? "{}")).toMatchObject({
      folderCount: 1,
      found: 2,
      depth: 6,
      fileLimit: 5000,
    });
    expect(scanned?.payload).not.toContain(f.models);
    expect(JSON.parse(scanned?.private ?? "{}")).toEqual({ folders: [f.models] });
    expect(f.frames.some((x) => x.kind === "scan" && x.done === true)).toBe(true);
  });

  it("says why a folder cannot be read and lists nothing from it", async () => {
    const r = await call("POST", "/api/config/models/folders", { path: join(f.dir, "missing") });
    expect(r.body.models).toEqual([]);
    expect(r.body.folders[0]).toMatchObject({ readable: false });
    expect(r.body.folders[0].error).toMatch(/does not exist/);
  });

  it("removes a folder, recording it, and keeps the other config lines", async () => {
    await call("POST", "/api/config/models/folders", { path: f.models, includeSubfolders: true });
    const r = await call("DELETE", "/api/config/models/folders", { path: f.models });
    expect(r.status).toBe(200);
    expect(r.body.models).toEqual([]);
    expect(await events("models/folder_removed")).toHaveLength(1);
    expect(readFileSync(f.userConfig, "utf8")).toMatch(/\[team\]/);
  });

  it("hashes in the background and marks a registry match Verified (MD-N12-2)", async () => {
    const sha = createHash("sha256")
      .update(readFileSync(join(f.models, "tiny-Q4_K_M.gguf")))
      .digest("hex");
    f.registry.upsert("tiny-llama", { family: "llama", sha256: sha });
    await call("POST", "/api/config/models/folders", { path: f.models });
    await f.api.hashingDone();
    const r = await call("GET", "/api/config/models");
    const tiny = (r.body.models as Json[]).find((m) => m.name === "Tiny Llama");
    expect(tiny).toMatchObject({
      hash: "verified",
      verified: true,
      id: sha,
      registryId: "tiny-llama",
    });
    expect((r.body.models as Json[]).find((m) => m.name === "Giant")?.hash).toBe("not_registry");
    expect(f.frames.some((x) => x.kind === "hash" && x.hash === "verified")).toBe(true);
  });
});

describe("roles (DB-N6-4, DB-N6-5, MD-N12-4, MD-N12-5)", () => {
  it("shows the four roles in order with the recommendation, and assigns, loads and fetches nothing", async () => {
    await call("POST", "/api/config/models/folders", { path: f.models });
    const before = f.registry.roleAssignments(HOST).length;
    const r = await call("GET", "/api/config/roles");
    expect((r.body.roles as Json[]).map((x) => x.role)).toEqual([
      "worker",
      "planner",
      "reviewer",
      "researcher",
    ]);
    const planner = (r.body.roles as Json[])[1];
    expect(planner.note).toBe("Seshat, the project manager, runs on this model.");
    const worker = (r.body.roles as Json[])[0];
    expect(worker.state).toBe("not_configured");
    expect(worker.recommendation.model).toBe("tiny-llama");
    expect(worker.recommendation.reason).toMatch(/^Tiny Llama: it fits at/);
    expect((r.body.roles as Json[])[2].screen).toBe("not_measured");
    expect(f.registry.roleAssignments(HOST).length).toBe(before);
    expect(await events("harness/egress")).toEqual([]);
    expect(f.hubRequests).toEqual([]);
  });

  it("refuses an unqualified model naming the qualification, assigns a qualified one, and restores the previous", async () => {
    await call("POST", "/api/config/models/folders", { path: f.models });
    const refused = await call("PUT", "/api/config/roles/worker", { model: "tiny-llama" });
    expect(refused.status).toBe(409);
    expect(refused.body.needs).toBe("qualification");
    expect(refused.body.error).not.toMatch(/sekhemet /);
    f.registry.upsert("tiny-llama", {
      family: "llama",
      qualification: { suiteVersion: "q1", passRate: 1, date: "2026-09-26", status: "qualified" },
    });
    f.registry.upsert("other", {
      family: "llama",
      qualification: { suiteVersion: "q1", passRate: 1, date: "2026-09-26", status: "qualified" },
    });
    expect((await call("PUT", "/api/config/roles/worker", { model: "other" })).status).toBe(200);
    const ok = await call("PUT", "/api/config/roles/worker", { model: "tiny-llama" });
    expect(ok.status).toBe(200);
    expect(ok.body.role).toMatchObject({
      role: "worker",
      model: "tiny-llama",
      qualified: true,
      previous: "other",
    });
    const assigned = (await events("models/assigned")).map((e) => JSON.parse(e.payload));
    expect(assigned.at(-1)).toMatchObject({
      role: "worker",
      model: "tiny-llama",
      previous: "other",
    });
    const restored = await call("POST", "/api/config/roles/worker/restore");
    expect(restored.body.role.model).toBe("other");
    expect(await events("models/restored")).toHaveLength(1);
  });

  it("refuses a Reviewer of the Worker's family, saying why", async () => {
    await call("POST", "/api/config/models/folders", { path: f.models });
    f.registry.upsert("tiny-llama", {
      family: "llama",
      qualification: { suiteVersion: "q1", passRate: 1, date: "2026-09-26", status: "qualified" },
    });
    await call("PUT", "/api/config/roles/worker", { model: "tiny-llama" });
    const r = await call("PUT", "/api/config/roles/reviewer", { model: "tiny-llama" });
    expect(r.status).toBe(409);
    expect(r.body.needs).toBe("other-family");
    expect(r.body.error).toMatch(/Worker's family/);
  });

  it("refuses to load when no residency scheduler is here, saying so", async () => {
    await call("POST", "/api/config/models/folders", { path: f.models });
    f.registry.upsert("tiny-llama", {
      family: "llama",
      qualification: { suiteVersion: "q1", passRate: 1, date: "2026-09-26", status: "qualified" },
    });
    await call("PUT", "/api/config/roles/worker", { model: "tiny-llama" });
    const r = await call("POST", "/api/config/roles/worker/load");
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/residency scheduler/);
  });
});

describe("downloads (MD-N12-6, MD-N12-7, SEC-53, DB-N6-6/7)", () => {
  const register = (host: string, sha = f.weightsSha) =>
    f.registry.recordSource("reg-model", {
      url:
        host === "hub"
          ? `${f.hubBase}/org/r/resolve/main/w.gguf`
          : "https://huggingface.co/org/r/resolve/main/w.gguf",
      host: host === "hub" ? "127.0.0.1" : "huggingface.co",
      sha256: sha,
      sizeBytes: f.weights.length,
    });

  it("refuses under [network] mode offline, naming the setting, and makes no request", async () => {
    await call("POST", "/api/config/models/folders", { path: f.models });
    register("public");
    const r = await call("POST", "/api/config/downloads", { model: "reg-model", folder: f.models });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/\[network\] mode/);
    expect(f.hubRequests).toEqual([]);
  });

  it("refuses a model with no registered source and hash", async () => {
    await call("POST", "/api/config/models/folders", { path: f.models });
    const r = await call("POST", "/api/config/downloads", {
      model: "nothing-registered",
      folder: f.models,
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/no registered source and hash/);
  });

  it("downloads only on the POST, verifies the hash, then records it with the principal", async () => {
    await call("POST", "/api/config/models/folders", { path: f.models });
    register("hub");
    expect(f.hubRequests).toEqual([]);
    const r = await call("POST", "/api/config/downloads", { model: "reg-model", folder: f.models });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({
      destination: f.models,
      sizeBytes: f.weights.length,
      sha256: f.weightsSha,
    });
    await waitFor(() => f.frames.some((x) => x.kind === "download" && x.state === "done"));
    await waitFor(async () => (await events("model/downloaded")).length === 1);
    expect(readFileSync(join(f.models, "w.gguf")).equals(f.weights)).toBe(true);
    expect(JSON.parse((await events("model/downloaded"))[0]?.payload ?? "{}")).toEqual({
      model: "reg-model",
      source: "127.0.0.1",
      sha256: f.weightsSha,
      bytes: f.weights.length,
      principal: "p_owner",
      verified: true,
    });
    const states = f.frames.filter((x) => x.kind === "download").map((x) => x.state);
    expect(states).toContain("verifying");
  });

  it("writes only into the folder the dialog showed: configured, there and writable, never re-created", async () => {
    register("hub");
    const gone = join(dirname(f.models), "passport-llm");
    mkdirSync(gone);
    await call("POST", "/api/config/models/folders", { path: f.models });
    await call("POST", "/api/config/models/folders", { path: gone });
    // The drive is unplugged after the folder was added.
    rmSync(gone, { recursive: true, force: true });
    const unnamed = await call("POST", "/api/config/downloads", { model: "reg-model" });
    expect(unnamed.status).toBe(409);
    expect(unnamed.body.error).toMatch(/Name the folder/);
    const other = await call("POST", "/api/config/downloads", {
      model: "reg-model",
      folder: join(dirname(f.models), "elsewhere"),
    });
    expect(other.status).toBe(409);
    expect(other.body.error).toMatch(/only into a model folder you added/);
    const unplugged = await call("POST", "/api/config/downloads", {
      model: "reg-model",
      folder: gone,
    });
    expect(unplugged.status).toBe(409);
    expect(unplugged.body.error).toMatch(/is not there or cannot be written/);
    expect(existsSync(gone)).toBe(false);
    expect(f.hubRequests).toEqual([]);
    // The page offers the first folder that can take it, never the unplugged one.
    const models = await call("GET", "/api/config/models");
    const folders = models.body.folders as { path: string; writable?: boolean }[];
    expect(folders.find((x) => x.path === gone)?.writable).toBe(false);
    expect(folders.find((x) => x.path === f.models)?.writable).toBe(true);
  });

  it("deletes a file whose hash differs and says so", async () => {
    await call("POST", "/api/config/models/folders", { path: f.models });
    register("hub", "0".repeat(64));
    await call("POST", "/api/config/downloads", { model: "reg-model", folder: f.models });
    await waitFor(() =>
      f.frames.some((x) => x.kind === "download" && x.state === "failed" && x.error),
    );
    const failed = f.frames.find((x) => x.kind === "download" && x.error);
    expect(String(failed?.error)).toMatch(/hash didn't match the published one, so it was deleted/);
    expect(existsSync(join(f.models, "w.gguf"))).toBe(false);
    expect(readdirSync(f.models).some((n) => n.endsWith(".part"))).toBe(false);
  });
});

describe("model details: every number graded (DB-NM14-1, DB-NM14-2)", () => {
  it("serves identity, memory with a what-if, speeds and loads, each number with its grade", async () => {
    await call("POST", "/api/config/models/folders", { path: f.models });
    const list = await call("GET", "/api/config/models");
    const id = (list.body.models as Json[]).find((m) => m.name === "Tiny Llama").id;
    const a = await call("GET", `/api/config/models/${id}?role=worker&context=8192&kvType=q8_0`);
    const b = await call("GET", `/api/config/models/${id}?role=worker&context=32768&kvType=q8_0`);
    expect(a.status).toBe(200);
    expect(b.body.memory.kvBytes.value).toBeCloseTo(4 * a.body.memory.kvBytes.value, -3);
    const ungraded: string[] = [];
    const walk = (x: unknown, path: string) => {
      if (Array.isArray(x)) x.forEach((v, i) => walk(v, `${path}[${i}]`));
      else if (x && typeof x === "object") {
        const o = x as Record<string, unknown>;
        if (
          typeof o.value === "number" &&
          !["measured", "estimated", "design", "file"].includes(String(o.grade))
        )
          ungraded.push(path);
        for (const [k, v] of Object.entries(o)) {
          if (k === "model") continue;
          walk(v, `${path}.${k}`);
        }
      }
    };
    walk(a.body, "$");
    expect(ungraded).toEqual([]);
    // Read from the file (its size, its header), never labelled Measured.
    expect(a.body.memory.weightsBytes.grade).toBe("file");
    expect(a.body.model.identity.sizeBytes.grade).toBe("file");
    expect(a.body.model.identity.contextLength.grade).toBe("file");
    expect(a.body.speeds[0].decodeTokensPerSecond.grade).toBe("estimated");
    expect(a.body.loads.map((l: Json) => l.volume)).toEqual(["internal", "external"]);
    expect(a.body.warnings.join(" ")).toMatch(/Not qualified for the worker/);
  });
});

describe("Measure speed (DB-NM14-3): a person's confirmed action, recorded, then shown Measured", () => {
  it("refuses without a confirmation naming the model and its memory, runs on one, records it and shows it", async () => {
    f.api.close();
    await new Promise<void>((r) => f.server.close(() => r()));
    await new Promise<void>((r) => f.hub.close(() => r()));
    f.db.close();
    rmSync(f.dir, { recursive: true, force: true });
    const asked: { model: string; path: string; role: string; depth: number }[] = [];
    await setup({
      measureSpeed: async (input) => {
        asked.push(input);
        return {
          bench: {
            accepted: true,
            depth: input.depth,
            decode: { value: 52, grade: "measured", spread: 0.01, runs: [52, 52, 52, 52, 52] },
            prefill: {
              value: 900,
              grade: "measured",
              spread: 0.01,
              runs: [900, 900, 900, 900, 900],
            },
            warmup: {},
          },
          ttft: {
            withoutCacheMs: { value: 800, grade: "measured" },
            withCacheMs: { value: 90, grade: "measured" },
            runs: 3,
          },
        };
      },
    });
    await call("POST", "/api/config/models/folders", { path: f.models });
    const list = await call("GET", "/api/config/models");
    const id = (list.body.models as Json[]).find((m) => m.name === "Tiny Llama").id;
    const refused = await call("POST", `/api/config/models/${id}/speed`, { role: "worker" });
    expect(refused.status).toBe(409);
    expect(refused.body.needs).toBe("confirmation");
    expect(refused.body.name).toBe("Tiny Llama");
    expect(refused.body.memoryBytes).toBeGreaterThan(0);
    expect(refused.body.error).toMatch(/loads Tiny Llama .* GB/);
    const wrong = await call("POST", `/api/config/models/${id}/speed`, {
      role: "worker",
      confirm: true,
      model: refused.body.model,
      memoryBytes: 1,
    });
    expect(wrong.status).toBe(409);
    expect(asked).toEqual([]);
    const ok = await call("POST", `/api/config/models/${id}/speed`, {
      role: "worker",
      confirm: true,
      model: refused.body.model,
      memoryBytes: refused.body.memoryBytes,
    });
    expect(ok.status).toBe(202);
    await waitFor(async () => (await events("model/speed_measured")).length === 1);
    expect(asked[0]).toMatchObject({ role: "worker", path: join(f.models, "tiny-Q4_K_M.gguf") });
    expect(JSON.parse((await events("model/speed_measured"))[0]?.payload ?? "{}")).toMatchObject({
      role: "worker",
      principal: "p_owner",
      accepted: true,
      decodeTokensPerSecond: 52,
      ttftWithoutCacheMs: 800,
      ttftWithCacheMs: 90,
    });
    const d = await call("GET", `/api/config/models/${id}?role=worker`);
    const llama = (d.body.speeds as Json[]).find((s) => s.engine === "llama.cpp");
    expect(llama.measuredDecodeTokensPerSecond).toMatchObject({ value: 52, grade: "measured" });
    expect(llama.ttft).toEqual({
      withoutCacheMs: { value: 800, grade: "measured" },
      withCacheMs: { value: 90, grade: "measured" },
    });
  });
});

describe("placement and the copy (MD-N14-41, DB-NM14-7, DB-NM14-8)", () => {
  it("suggests a copy of a model on a slower volume, copies only on the POST, verifies it and repoints the registry", async () => {
    f.api.close();
    await new Promise<void>((r) => f.server.close(() => r()));
    await new Promise<void>((r) => f.hub.close(() => r()));
    f.db.close();
    rmSync(f.dir, { recursive: true, force: true });
    await setup({ volume: (p) => (p.includes("/internal/") ? "internal" : "external") });
    await call("POST", "/api/config/models/folders", { path: f.models });
    await f.api.hashingDone();
    const p = await call("GET", "/api/config/placement");
    expect(p.status).toBe(200);
    expect((p.body.rows as Json[]).length).toBe(2);
    expect(p.body.keepFreeBytes).toBe(20e9);
    expect(existsSync(join(f.dir, "internal"))).toBe(false);
    const list = await call("GET", "/api/config/models");
    const tiny = (list.body.models as Json[]).find((m) => m.name === "Tiny Llama");
    const r = await call("POST", "/api/config/placement/copies", { model: tiny.id });
    expect(r.status).toBe(202);
    await waitFor(async () => (await events("model/copied")).length === 1);
    const copied = JSON.parse((await events("model/copied"))[0]?.payload ?? "{}");
    expect(copied).toMatchObject({
      sha256: tiny.sha256,
      from: "external",
      to: "internal",
      principal: "p_owner",
      verified: true,
    });
    expect((await events("model/copied"))[0]?.payload).not.toContain(f.dir);
    expect(existsSync(tiny.path)).toBe(true);
    expect(f.registry.preferredWeights(copied.model)).toMatch(/\/internal\//);
  });

  it("refuses a copy that would leave less than 20 GB free", async () => {
    f.api.close();
    await new Promise<void>((r) => f.server.close(() => r()));
    await new Promise<void>((r) => f.hub.close(() => r()));
    f.db.close();
    rmSync(f.dir, { recursive: true, force: true });
    await setup({ volume: () => "external", free: 20 * GB });
    await call("POST", "/api/config/models/folders", { path: f.models });
    await f.api.hashingDone();
    const list = await call("GET", "/api/config/models");
    const tiny = (list.body.models as Json[]).find((m) => m.name === "Tiny Llama");
    const r = await call("POST", "/api/config/placement/copies", { model: tiny.id });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/20 GB/);
  });
});

describe("combinations and residency (DB-NM14-6, DB-NM14-9)", () => {
  it("orders combinations with no combined score and excludes a same-family Reviewer with the reason", async () => {
    await call("POST", "/api/config/models/folders", { path: f.models });
    const r = await call("GET", "/api/config/combinations");
    expect(r.status).toBe(200);
    const all = r.body.combinations as Json[];
    expect(all.length).toBeGreaterThan(0);
    for (const c of all) expect(Object.keys(c)).not.toContain("score");
    const sameFamily = all.find((c) => c.combination.worker === c.combination.reviewer);
    expect(sameFamily?.excluded).toMatch(/Worker's family|does not fit/);
    const kept = all.filter((c) => !c.excluded);
    for (const c of kept)
      expect(["design", "estimated", "measured"]).toContain(c.estimate.timePerCardMs.grade);
  });

  it("builds a 24-hour timeline from the recorded loads and unloads, with θ per hour", async () => {
    const now = Date.now();
    f.log.appendNow({
      actor: "harness",
      type: "model/loaded",
      payload: {
        model: "w",
        roles: ["worker"],
        volume: "external",
        bytes: 13e9,
        cache: "cold",
        loadMs: 300_000,
        medianMs: 300_000,
        p90Ms: 300_000,
        basis: "estimate",
      },
    });
    f.log.appendNow({
      actor: "harness",
      type: "model/unloaded",
      payload: {
        model: "w",
        roles: ["worker"],
        volume: "external",
        bytes: 13e9,
        unloadMs: 2000,
        confirmed: true,
      },
    });
    const r = await call("GET", "/api/config/residency?hours=24");
    expect(r.body.segments.map((s: Json) => s.model)).toEqual(["w"]);
    expect(r.body.thetaByHour).toHaveLength(24);
    const last = r.body.thetaByHour.at(-1);
    expect(last.grade).toBe("measured");
    expect(last.value).toBeCloseTo(302_000 / 3_600_000, 5);
    expect(Date.parse(r.body.to)).toBeGreaterThanOrEqual(now);
  });
});

describe("permissions (DB-N6-15, PM_CONTRACT §3 Configuration)", () => {
  it("every Configuration change needs config.manage, review capacity its own", () => {
    expect(routePermissions("POST", "/api/config/models/folders", undefined)?.permissions).toEqual([
      "config.manage",
    ]);
    expect(routePermissions("PUT", "/api/config/roles/worker", undefined)?.permissions).toEqual([
      "config.manage",
    ]);
    expect(
      routePermissions("POST", "/api/config/placement/copies", undefined)?.permissions,
    ).toEqual(["config.manage"]);
    expect(
      routePermissions("DELETE", "/api/config/downloads/dl_1", undefined)?.permissions,
    ).toEqual(["config.manage"]);
    expect(routePermissions("PUT", "/api/config/review", undefined)?.permissions).toEqual([
      "review.capacity",
    ]);
    expect(routePermissions("GET", "/api/config/models", undefined)).toBeUndefined();
  });

  it("refuses a change without the dashboard's header", async () => {
    const res = await fetch(`${f.base}/api/config/models/scan`, { method: "POST" });
    expect(res.status).toBe(403);
  });
});

describe("writeModelFolders", () => {
  it("replaces a multi-line folders array and keeps the rest", () => {
    const p = join(f.dir, "u.toml");
    writeFileSync(
      p,
      '[models]\nplanner = "x"\nfolders = [\n  "/a",\n  "/b",\n]\n\n[team]\nmode = "solo"\n',
    );
    writeModelFolders(p, [{ path: "/c", includeSubfolders: true }]);
    const text = readFileSync(p, "utf8");
    expect(text).toContain('folders = [{ path = "/c", subfolders = true }]');
    expect(text).toContain('planner = "x"');
    expect(text).toContain('[team]\nmode = "solo"');
    expect(text).not.toContain('"/a"');
    chmodSync(p, 0o644);
  });
});

describe("review capacity (NEW-dashboard-4, review-git §2.2.3)", () => {
  it("refuses 0 or less, naming the key", async () => {
    const r = await call("PUT", "/api/config/review", { minutesPerDay: 0 });
    expect(r.status).toBe(400);
    expect(r.body.key).toBe("review_minutes_per_day");
  });
});

describe("a copy made by hand (MD-N14-41: prefer an internal copy with the same hash)", () => {
  it("recognises an internal copy with the same hash, and a person's Use it repoints the registry without copying", async () => {
    f.api.close();
    await new Promise<void>((r) => f.server.close(() => r()));
    await new Promise<void>((r) => f.hub.close(() => r()));
    f.db.close();
    rmSync(f.dir, { recursive: true, force: true });
    await setup({
      volume: (p) => (p.includes("/internal/") ? "internal" : "external"),
      free: 1 * GB,
    });
    // The Worker was copied by hand to the same layout under internal storage.
    const original = join(f.models, "tiny-Q4_K_M.gguf");
    mkdirSync(join(f.dir, "internal", "tiny-llama"), { recursive: true });
    writeFileSync(
      join(f.dir, "internal", "tiny-llama", "tiny-Q4_K_M.gguf"),
      readFileSync(original),
    );
    await call("POST", "/api/config/models/folders", { path: f.models });
    await f.api.hashingDone();
    const p = await call("GET", "/api/config/placement");
    const row = (p.body.rows as Json[]).find((r) => r.name === "Tiny Llama");
    expect(row?.internalCopy).toBe(join(f.dir, "internal", "tiny-llama", "tiny-Q4_K_M.gguf"));
    expect(row?.suggested).toBe(false);
    expect(row?.reason).toMatch(/internal copy with the same hash/);
    const list = await call("GET", "/api/config/models");
    const tiny = (list.body.models as Json[]).find((m) => m.name === "Tiny Llama");
    const r = await call("POST", "/api/config/placement/copies", { model: tiny.id });
    expect(r.status).toBe(202);
    await waitFor(async () => (await events("model/copied")).length === 1);
    const copied = JSON.parse((await events("model/copied"))[0]?.payload ?? "{}");
    expect(f.registry.preferredWeights(copied.model)).toBe(row?.internalCopy);
    expect(existsSync(original)).toBe(true);
  });
});
