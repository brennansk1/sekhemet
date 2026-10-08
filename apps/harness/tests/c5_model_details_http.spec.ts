import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeGguf } from "../../../packages/models/tests/support/gguf_fixture.js";
import { openLocalLedger } from "../src/ledger_cmds.js";
import { guardedImports, trackChild } from "./support/hygiene.js";

/**
 * A model's warnings on its details (dashboard DB-NM14-4, models MD-N14-20;
 * C2d G1 finding 7, routed to C5): `sekhemet serve` spawned as the built
 * binary (`apps/harness/dist/index.js`) over a models folder and a ledger
 * holding the model's recorded loads and an Ollama requantisation, asked
 * `/api/config/models/:id` over HTTP. No model is loaded.
 */

const BIN = resolve(import.meta.dirname, "../dist/index.js");
let root: string;
let home: string;
let repo: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "sek-c5-details-")));
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
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

async function serve(models: string): Promise<string> {
  const proc = trackChild(
    spawn(process.execPath, [...guardedImports(), BIN, "serve", "--port", "0"], {
      cwd: repo,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
        SEKHEMET_CONFIG_DIR: join(home, ".sekhemet"),
        SEKHEMET_MODEL_REGISTRY: join(home, ".sekhemet", "models.json"),
        SEKHEMET_MACHINE_PROFILE: join(home, ".sekhemet", "machine.json"),
        SEKHEMET_USER_CONFIG: "/nonexistent/sekhemet-test-user-config.toml",
        SEKHEMET_MODEL_LOADS: "off",
        SEKHEMET_KEYCHAIN: "off",
        SEKHEMET_MODELS_DIR: models,
        BROWSER: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    }),
  );
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
  });
}

describe("a model's warnings in words (DB-NM14-4, MD-N14-20)", () => {
  it("DB-NM14-4: the details name an Ollama requantisation, and an aging cap below the model's round trip with the predicted wait instead", async () => {
    const models = join(home, "models");
    mkdirSync(models, { recursive: true });
    writeGguf(join(models, "Tiel-Coder-35B.gguf"), {
      architecture: "qwen3moe",
      name: "Tiel Coder 35B",
      contextLength: 262144,
    });
    const key = "tiel-coder-35b";
    const { db, log } = openLocalLedger(repo);
    try {
      // Three recorded cold loads of ten minutes: its measured load time.
      for (let i = 0; i < 3; i++)
        await log.append({
          actor: "harness",
          type: "model/loaded",
          payload: {
            model: key,
            roles: ["planner"],
            volume: "internal",
            bytes: 1_000_000,
            cache: "cold",
            loadMs: 600_000,
            medianMs: 600_000,
            p90Ms: 600_000,
            basis: "measured",
          },
        });
      await log.append({
        actor: "harness",
        type: "model/requantised",
        payload: { model: key, servedQuant: "Q4_0", fileQuant: "Q4_K_M", hashDiffers: true },
      });
    } finally {
      db.close();
    }
    const base = await serve(models);
    const listed = (await (await fetch(`${base}/api/config/models`)).json()) as {
      models: { id: string; name: string }[];
    };
    const m = listed.models.find((x) => x.name === "Tiel Coder 35B");
    expect(m).toBeDefined();
    const res = await fetch(
      `${base}/api/config/models/${encodeURIComponent(m?.id ?? "")}?role=planner`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { warnings?: string[] };
    const warnings = (body.warnings ?? []).join("\n");
    expect(warnings).toMatch(/Ollama serves it requantised \(Q4_0 where the file is Q4_K_M/);
    expect(warnings).toMatch(/llama-server/);
    // Seshat's interactive answers cap at 2 min; the round trip is about 10 min.
    expect(warnings).toMatch(/aging cap[^\n]*2 min[^\n]*predicted wait is about 10 min/);
    // The Planning model's own 30-minute cap can be met: not flagged.
    expect(warnings).not.toMatch(/30 min[^\n]*predicted wait/);
  }, 120_000);
});
