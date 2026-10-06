import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeGguf } from "../../../packages/models/tests/support/gguf_fixture.js";
import { pageWriteHeaders } from "./page_headers.js";

/**
 * The Configuration page's Models section as the page asks for it (C2d,
 * FINDINGS_C1 TST-01; models.md NEW-models-12, -13): the built command
 * `sekhemet serve` spawned with a throwaway home whose model folders the
 * test lays out, and its `/api/config/models` routes asked over HTTP. The
 * GGUF files are real headers (a sparse file where a model must be large);
 * no model is loaded and nothing leaves the machine.
 */

const BIN = resolve(import.meta.dirname, "../dist/index.js");

let root: string;
let home: string;
let repo: string;
let child: ChildProcess | undefined;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "sek-models-page-")));
  home = join(root, "home");
  repo = join(root, "repo");
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "ada@example.com");
  git("config", "user.name", "Ada Lovelace");
  writeFileSync(join(repo, "README.md"), "# Timesheets\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  child = undefined;
});

afterEach(async () => {
  if (child && child.exitCode === null) {
    child.kill("SIGKILL");
    await new Promise((r) => child?.once("close", r));
  }
  rmSync(root, { recursive: true, force: true });
});

/** A person's shell with the throwaway home: the server and any command share it. */
const shellEnv = (env: Record<string, string> = {}): Record<string, string> => ({
  PATH: process.env.PATH ?? "",
  HOME: home,
  SEKHEMET_CONFIG_DIR: join(home, ".sekhemet"),
  SEKHEMET_MODEL_REGISTRY: join(home, ".sekhemet", "models.json"),
  SEKHEMET_MACHINE_PROFILE: join(home, ".sekhemet", "machine.json"),
  SEKHEMET_USER_CONFIG: join(home, "user.toml"),
  SEKHEMET_MODEL_LOADS: "off",
  SEKHEMET_KEYCHAIN: "off",
  BROWSER: "false",
  ...env,
});

/** `sekhemet serve --port 0` with the throwaway home; resolves with its address. */
async function serve(env: Record<string, string> = {}): Promise<string> {
  const proc = spawn(process.execPath, [BIN, "serve", "--port", "0"], {
    cwd: repo,
    env: shellEnv(env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child = proc;
  let out = "";
  return new Promise<string>((ok, bad) => {
    const timer = setTimeout(() => bad(new Error(`no address: ${out}`)), 60_000);
    const read = (d: Buffer) => {
      out += String(d);
      const m = /running at:\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        ok(m[1] as string);
      }
    };
    proc.stdout?.on("data", read);
    proc.stderr?.on("data", read);
    proc.once("exit", (code) => bad(new Error(`serve exited ${code}: ${out}`)));
  });
}

interface FoundModel {
  id: string;
  name: string;
  path: string;
  fits: Record<string, string>;
  fitReason: Record<string, string>;
}
interface ModelsBody {
  folders: { path: string }[];
  suggestedFolders: string[];
  models: FoundModel[];
}

async function getJson<T>(url: string): Promise<{ status: number; body: T }> {
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  return { status: r.status, body: (await r.json()) as T };
}

async function send<T>(
  base: string,
  method: string,
  path: string,
  body: unknown,
): Promise<{ status: number; body: T }> {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(await pageWriteHeaders(base)) },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as T };
}

describe("suggested model folders (MD-N12-8)", () => {
  it("MD-N12-8: suggests exactly the known folders that exist here and are not configured, and scans none of them until a person adds one", async () => {
    const models = join(home, "models");
    const ollama = join(home, ".ollama", "models");
    const lmstudio = join(home, ".lmstudio", "models");
    for (const d of [models, ollama, lmstudio]) mkdirSync(d, { recursive: true });
    // A model in LM Studio's folder: it must not be scanned while only suggested.
    writeGguf(join(lmstudio, "Suggested-Only-7B.gguf"), {
      architecture: "qwen3",
      name: "Suggested Only 7B",
    });
    const base = await serve({ SEKHEMET_MODELS_DIR: models });
    const first = await getJson<ModelsBody>(`${base}/api/config/models`);
    expect(first.status).toBe(200);
    const configured = first.body.folders.map((f) => resolve(f.path));
    const suggested = first.body.suggestedFolders.map((p) => resolve(p));
    // Hugging Face's cache and llama.cpp's do not exist here: never suggested.
    const expected = [models, ollama, lmstudio].filter((p) => !configured.includes(p)).sort();
    expect([...suggested].sort()).toEqual(expected);
    expect(suggested).toContain(ollama);
    expect(suggested).toContain(lmstudio);
    for (const c of configured) expect(suggested).not.toContain(c);
    expect(first.body.models.map((m) => m.name)).not.toContain("Suggested Only 7B");
    // A person adds LM Studio's folder: now it is scanned, and no longer suggested.
    const added = await send<ModelsBody>(base, "POST", "/api/config/models/folders", {
      path: lmstudio,
    });
    expect(added.status).toBe(200);
    expect(added.body.models.map((m) => m.name)).toContain("Suggested Only 7B");
    expect(added.body.suggestedFolders.map((p) => resolve(p))).not.toContain(lmstudio);
  }, 120_000);
});

describe("fitting a found model for a role (MD-N12-3)", () => {
  it("MD-N12-3: a model too large for this machine is listed as needing N GB, and is refused when a person assigns it; a small one fits", async () => {
    const models = join(home, "models");
    mkdirSync(models, { recursive: true });
    writeGguf(join(models, "Small-Coder-1B.gguf"), {
      architecture: "qwen3",
      name: "Small Coder 1B",
    });
    // 2 TB of weights, as a sparse file: more than any machine here can hold.
    const huge = writeGguf(join(models, "Huge-Coder-4T.gguf"), {
      architecture: "qwen3",
      name: "Huge Coder 4T",
    });
    truncateSync(huge, 2 * 1024 ** 4);
    const base = await serve({ SEKHEMET_MODELS_DIR: models });
    const listed = await getJson<ModelsBody>(`${base}/api/config/models`);
    const big = listed.body.models.find((m) => m.name === "Huge Coder 4T");
    const small = listed.body.models.find((m) => m.name === "Small Coder 1B");
    expect(big).toBeDefined();
    expect(small).toBeDefined();
    for (const role of ["worker", "planner", "reviewer", "researcher"]) {
      expect(big?.fits[role]).toBe("no");
      expect(big?.fitReason[role]).toMatch(
        /^Needs [\d.]+ GB more: [\d.]+ GB (of [\d.]+ GB usable|on the GPU is above)/,
      );
    }
    expect(["yes", "swaps"]).toContain(small?.fits.worker);
    // Never loaded: assigning it to a role is refused with the shortfall.
    const assigned = await send<{ error?: string }>(base, "PUT", "/api/config/roles/worker", {
      model: big?.id,
    });
    expect(assigned.status).toBe(409);
    expect(String(assigned.body.error)).toMatch(/does not fit this machine for the worker: Needs/);
  }, 120_000);
});

describe("filling a found model's specs (MD-N13-2)", () => {
  it("MD-N13-2: with research not allowed, a model's details show its header metadata only and say no lookup was made", async () => {
    const models = join(home, "models");
    mkdirSync(models, { recursive: true });
    writeGguf(join(models, "Tiel-Coder-35B.gguf"), {
      architecture: "qwen3moe",
      name: "Tiel Coder 35B",
      contextLength: 262144,
    });
    writeFileSync(join(home, "user.toml"), '[network]\nresearch = "no"\n');
    const base = await serve({ SEKHEMET_MODELS_DIR: models });
    const listed = await getJson<ModelsBody>(`${base}/api/config/models`);
    const m = listed.body.models.find((x) => x.name === "Tiel Coder 35B");
    expect(m).toBeDefined();
    const details = await getJson<{
      lookup?: { lookedUp?: boolean; note?: string };
      metadata?: Record<string, unknown>;
    }>(`${base}/api/config/models/${encodeURIComponent(m?.id ?? "")}?lookup=1`);
    expect(details.status).toBe(200);
    expect(details.body.lookup?.lookedUp).toBe(false);
    expect(String(details.body.lookup?.note)).toMatch(/no lookup|not allowed|research/i);
    expect(JSON.stringify(details.body.metadata ?? {})).not.toMatch(/huggingface/);
  }, 120_000);
});

describe("the model registry shared by the server and a command (MD-N4-5, MD-N4-5a)", () => {
  it("MD-N4-5, MD-N4-5a: a model `models add` registers while the server runs survives the server's next registry write", async () => {
    const models = join(home, "models");
    mkdirSync(models, { recursive: true });
    const base = await serve({ SEKHEMET_MODELS_DIR: models });
    // The server has read the registry (the Models section).
    expect((await getJson<ModelsBody>(`${base}/api/config/models`)).status).toBe(200);
    // Another process — a person's terminal — registers a model meanwhile.
    const file = writeGguf(join(home, "Tiel-Coder.gguf"), {
      architecture: "qwen3moe",
      name: "Tiel Coder",
    });
    const added = execFileSync(
      process.execPath,
      [BIN, "models", "add", file, "--id", "tiel-coder"],
      {
        cwd: repo,
        env: shellEnv({ SEKHEMET_MODELS_DIR: models }),
        encoding: "utf8",
      },
    );
    expect(added).toMatch(/tiel-coder/);
    // Then the server writes the registry: the Coding model's settings from the page.
    const saved = await send<{ error?: string }>(base, "PUT", "/api/config/roles/worker/settings", {
      model: "tiel-coder",
      values: { temperature: 0.5 },
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const registry = readFileSync(join(home, ".sekhemet", "models.json"), "utf8");
    // The command's entry, with its recorded weights, is still there beside the server's write.
    expect(registry).toContain('"tiel-coder"');
    expect(registry).toContain(file);
    expect(registry).toMatch(/"temperature": 0\.5/);
  }, 120_000);
});

describe("recommending role combinations (MD-N14-42)", () => {
  it("MD-N14-42: the Configuration page's combinations put every role's quality floor first, then the least time per issue with swaps, then the smaller footprint, with no combined score, the Review model's family apart", async () => {
    const models = join(home, "models");
    mkdirSync(models, { recursive: true });
    const add = (file: string, id: string) =>
      execFileSync(process.execPath, [BIN, "models", "add", file, "--id", id], {
        cwd: repo,
        env: shellEnv({ SEKHEMET_MODELS_DIR: models }),
        encoding: "utf8",
      });
    // Two coders of one family, the second larger; a reviewer of another family.
    add(
      writeGguf(join(models, "Coder-A.gguf"), { architecture: "qwen3", name: "Coder A" }),
      "coder-a",
    );
    const b = writeGguf(join(models, "Coder-B.gguf"), { architecture: "qwen3", name: "Coder B" });
    truncateSync(b, 3 * 1024 ** 3);
    add(b, "coder-b");
    add(
      writeGguf(join(models, "Reviewer-L.gguf"), { architecture: "llama", name: "Reviewer L" }),
      "reviewer-l",
    );
    // Qualified on this host: Coder A for every role but review, Reviewer L for review.
    execFileSync(
      process.execPath,
      [
        resolve(import.meta.dirname, "support/g5_models.mjs"),
        JSON.stringify([
          { qualify: "coder-a", role: "worker", family: "qwen" },
          { qualify: "coder-a", role: "planner", as: "planner" },
          { qualify: "coder-a", role: "researcher", as: "researcher" },
          { qualify: "reviewer-l", role: "reviewer", as: "reviewer", family: "llama" },
          { qualify: "coder-b", role: "worker", family: "qwen" },
        ]),
      ],
      { env: shellEnv({ SEKHEMET_MODELS_DIR: models }), encoding: "utf8" },
    );
    const base = await serve({ SEKHEMET_MODELS_DIR: models });
    interface Ranked {
      combination: Record<string, string>;
      floorsMet: boolean;
      peakBytes: { value: number };
      excluded?: string;
      estimate?: { timePerCardMs: { value: number; grade: string }; cardsReplayed: number };
    }
    const got = await getJson<{ combinations: Ranked[]; order: string }>(
      `${base}/api/config/combinations`,
    );
    expect(got.status).toBe(200);
    expect(got.body.order).toBe(
      "quality floors, then time per issue including swaps, then footprint (no combined score)",
    );
    // No weighted combined score anywhere in what the page is given.
    expect(JSON.stringify(got.body)).not.toMatch(/"score"|"combinedScore"|"weightedScore"/i);
    const all = got.body.combinations;
    expect(all.length).toBeGreaterThan(1);
    const kept = all.filter((c) => !c.excluded);
    const excluded = all.filter((c) => c.excluded);
    // Excluded last, each with its reason: a Review model of the Coding model's family.
    expect(all.slice(kept.length)).toEqual(excluded);
    expect(excluded.length).toBeGreaterThan(0);
    for (const c of excluded)
      expect(c.excluded).toMatch(
        /Review model .* is of the Coding model's family|family is unknown|does not fit/,
      );
    // Every role's floor met first: the qualified line-up leads.
    expect(kept[0]?.floorsMet).toBe(true);
    expect(kept[0]?.combination).toMatchObject({ worker: "coder-a", reviewer: "reviewer-l" });
    // Then the least time per issue, then the smaller footprint.
    for (let i = 1; i < kept.length; i++) {
      const [a, b2] = [kept[i - 1] as Ranked, kept[i] as Ranked];
      if (a.floorsMet !== b2.floorsMet) {
        expect(a.floorsMet).toBe(true);
        continue;
      }
      const [ta, tb] = [
        a.estimate?.timePerCardMs.value ?? 0,
        b2.estimate?.timePerCardMs.value ?? 0,
      ];
      expect(ta).toBeLessThanOrEqual(tb);
      if (ta === tb) expect(a.peakBytes.value).toBeLessThanOrEqual(b2.peakBytes.value);
    }
    // No card of this person replayed yet: the time is the design's value, labelled so.
    for (const c of kept) {
      expect(c.estimate?.cardsReplayed).toBe(0);
      expect(c.estimate?.timePerCardMs.grade).toBe("design");
    }
  }, 120_000);
});
