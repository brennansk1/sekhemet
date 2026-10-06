import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { writeGguf } from "../../../packages/models/tests/support/gguf_fixture.js";
import { g2Dirs } from "./support/g2_cli.js";
import { SCRIPTED_MODEL, scriptEnv } from "./support/g2_model.js";
import { type G2Project, g2Project } from "./support/g2_project.js";

/**
 * The model roles reached the way a person reaches them (C2d, FINDINGS_C1
 * TST-01; models.md rules 13, 27, 30a; NEW-models-2, -4, -10, -12): the
 * built command (`apps/harness/dist/index.js`) spawned in a real repository
 * with a throwaway home — `run`, `queue`, `qualify --override`,
 * `models assign | restore | list`, `models add` and `doctor` — its Worker
 * a scripted model at the HTTP boundary (`g2_model.ts`'s preload: no model
 * is loaded, nothing leaves the machine). What a person's earlier work left
 * on the host (a qualification, a measured speed) is written by
 * `support/g5_models.mjs` with the binary's own modules.
 */

const BIN = resolve(import.meta.dirname, "../dist/index.js");
const SETUP = resolve(import.meta.dirname, "support/g5_models.mjs");

interface Out {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** `sekhemet <args>` spawned in the project, the scripted model preloaded. */
function sekhemet(args: string[], p: G2Project, extra: Record<string, string> = {}): Promise<Out> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ["--import", p.preload, BIN, ...args], {
      cwd: p.repo,
      env: { ...p.env, ...scriptEnv(p.record), ...extra },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => {
      stdout += String(b);
    });
    child.stderr.on("data", (b) => {
      stderr += String(b);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(new Error(`sekhemet ${args.join(" ")} timed out\n${stdout}\n${stderr}`));
    }, 150_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      done({ status, stdout, stderr });
    });
  });
}

/** Steps for `g5_models.mjs`: qualifications and a measured speed on this host. */
type Step =
  | {
      qualify: string;
      role?: string;
      as?: string;
      status?: "qualified" | "failed";
      family?: string;
    }
  | { profile: string; prefill: number; decode: number };
function setUp(p: G2Project, steps: Step[]): void {
  execFileSync(process.execPath, [SETUP, JSON.stringify(steps)], { env: p.env, encoding: "utf8" });
}

/** A repository with one Ready card writing `src/a.ts`, nothing qualified yet. */
async function project(): Promise<G2Project> {
  return g2Project(g2Dirs(), {
    cards: [
      {
        id: "c1",
        tier: "story",
        title: "Write a",
        status: "ready",
        scopeFiles: ["src/a.ts"],
        stepBudget: 4,
        spec: "Export a constant named a from src/a.ts",
        acceptanceCriteria: ["src/a.ts exports a"],
      },
    ],
    qualifyAs: [],
  });
}

const ledger = (p: G2Project) => join(p.repo, ".sekhemet", "events.db");
function card(p: G2Project, id: string): { status: string; attempts: number } {
  const db = new DatabaseSync(ledger(p), { readOnly: true });
  try {
    const c = db.prepare("SELECT status FROM cards WHERE id = ?").get(id) as { status: string };
    const a = db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE card_id = ?").get(id) as {
      n: number;
    };
    return { status: c.status, attempts: a.n };
  } finally {
    db.close();
  }
}
const registryFile = (p: G2Project) => p.env.SEKHEMET_MODEL_REGISTRY as string;
const registryText = (p: G2Project) =>
  existsSync(registryFile(p)) ? readFileSync(registryFile(p), "utf8") : "";

describe("the throughput floor at `run` and `queue` (MD-N2-1, MD-N2-3)", () => {
  it("MD-N2-1, MD-N2-3: a Worker measured below the overnight floor is refused by `run` as by `queue`, naming the measured and required prefill and decode rates, and no card starts", async () => {
    const p = await project();
    setUp(p, [{ qualify: SCRIPTED_MODEL }, { profile: SCRIPTED_MODEL, prefill: 20, decode: 4 }]);
    const floor =
      /Refusing to run cards on scripted-worker:latest: measured prefill 20\.0 tok\/s \(required \d+\), decode 4\.0 tok\/s \(required \d+\)/;
    const run = await sekhemet(["run", "c1", "--worker", SCRIPTED_MODEL], p);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(floor);
    const queue = await sekhemet(["queue", "--worker", SCRIPTED_MODEL], p);
    expect(queue.status).toBe(1);
    expect(queue.stderr).toMatch(floor);
    expect(card(p, "c1")).toEqual({ status: "ready", attempts: 0 });
  }, 180_000);
});

describe("the Worker's qualification at `queue` (MD-N4-4)", () => {
  it("MD-N4-4: an unverified or failed Worker is refused; a person's `qualify --override` of the failure lets it run, and the evidence says so", async () => {
    const p = await project();
    // Never measured: refused, naming the command that verifies it.
    const missing = await sekhemet(["queue", "--worker", SCRIPTED_MODEL], p);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(
      /Refusing scripted-worker:latest as the Coding model: not verified on this machine .*\(never qualified on this host\)/,
    );
    expect(missing.stderr).toContain(`sekhemet qualify --models ${SCRIPTED_MODEL}`);
    // An override cannot stand in for a measurement.
    const early = await sekhemet(
      ["qualify", "--override", SCRIPTED_MODEL, "--by", "Jane Doe", "--reason", "accepted"],
      p,
    );
    expect(early.status).toBe(1);
    expect(early.stdout + early.stderr).toMatch(/qualify it first/);
    // Measured and failed: still refused.
    setUp(p, [{ qualify: SCRIPTED_MODEL, status: "failed" }]);
    const failed = await sekhemet(["queue", "--worker", SCRIPTED_MODEL], p);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toMatch(
      /Refusing scripted-worker:latest as the Coding model: failed for this combination on this host \(this combination failed qualification: pass rate 40%\)/,
    );
    expect(card(p, "c1")).toEqual({ status: "ready", attempts: 0 });
    // A person accepts the measured failure; the run goes ahead under it.
    const override = await sekhemet(
      [
        "qualify",
        "--override",
        SCRIPTED_MODEL,
        "--by",
        "Jane Doe",
        "--reason",
        "tool calls at 40% are enough for this spike",
      ],
      p,
    );
    expect(override.status).toBe(0);
    const ran = await sekhemet(["queue", "--worker", SCRIPTED_MODEL], p, {
      ...scriptEnv(p.record, {
        worker: [
          [
            {
              name: "write_file",
              arguments: { path: "src/a.ts", content: "export const a = 1;\n" },
            },
          ],
          [{ name: "finish_card" }],
        ],
      }),
    });
    expect(ran.stdout).toMatch(/Coding model scripted-worker:latest: .*Jane Doe/);
    expect(card(p, "c1").attempts).toBe(1);
    const evidence = join(p.repo, ".sekhemet", "evidence");
    const bundles = readdirSync(evidence).filter((f) => f.startsWith("ev_") || f.endsWith(".json"));
    const text = bundles.map((f) => readFileSync(join(evidence, f), "utf8")).join("\n");
    expect(text).toContain("Jane Doe");
    expect(text).toContain("tool calls at 40% are enough for this spike");
  }, 300_000);
});

describe("assigning and restoring a role's model (MD-N10-1, MD-N10-2, MD-N4-9)", () => {
  it("MD-N10-2: a replaced assignment is kept, and `models restore worker` brings it back in one command", async () => {
    const p = await project();
    setUp(p, [{ qualify: "alpha-coder:latest" }, { qualify: "beta-coder:latest" }]);
    const first = await sekhemet(["models", "assign", "worker", "alpha-coder:latest"], p);
    expect(first.status).toBe(0);
    expect(first.stdout).toMatch(/worker: alpha-coder:latest assigned \(personal\)/);
    const second = await sekhemet(["models", "assign", "worker", "beta-coder:latest"], p);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain(
      "replacing alpha-coder:latest; restore it with: sekhemet models restore worker",
    );
    const restored = await sekhemet(["models", "restore", "worker"], p);
    expect(restored.status).toBe(0);
    expect(restored.stdout).toMatch(
      /worker: restored alpha-coder:latest \(replacing beta-coder:latest\)/,
    );
    const list = await sekhemet(["models", "list"], p);
    expect(list.stdout).toMatch(/^worker: alpha-coder:latest \(personal/m);
  }, 180_000);

  it("MD-N10-1: changing the recorded baseline or the shipped default needs a recorded bake-off on this host", async () => {
    const p = await project();
    setUp(p, [{ qualify: "alpha-coder:latest" }]);
    for (const scope of ["--baseline", "--default"]) {
      const refused = await sekhemet(
        ["models", "assign", "worker", "alpha-coder:latest", scope],
        p,
      );
      expect(refused.status).toBe(1);
      expect(refused.stdout + refused.stderr).toMatch(/bake-off/);
    }
    const unknown = await sekhemet(
      ["models", "assign", "worker", "alpha-coder:latest", "--baseline", "--bake-off", "ev_nope"],
      p,
    );
    expect(unknown.status).toBe(1);
    expect(unknown.stdout + unknown.stderr).toContain("No recorded benchmark ev_nope");
    const list = await sekhemet(["models", "list"], p);
    expect(list.stdout).not.toMatch(/baseline alpha-coder/);
  }, 180_000);

  it("MD-N4-9: a Reviewer of the Worker's family is refused naming both families, and with no other family qualified the Reviewer is unfilled", async () => {
    const p = await project();
    setUp(p, [{ qualify: "qwen-alpha:latest", family: "qwen" }]);
    expect((await sekhemet(["models", "assign", "worker", "qwen-alpha:latest"], p)).status).toBe(0);
    // Verified for the Review role on this host as `qualify --models <m> --role reviewer`
    // records it (the model described as the Worker is): only its family stands in the way.
    setUp(p, [{ qualify: "qwen-beta:latest", role: "reviewer", as: "worker", family: "qwen" }]);
    const refused = await sekhemet(["models", "assign", "reviewer", "qwen-beta:latest"], p);
    expect(refused.status).toBe(1);
    expect(refused.stdout + refused.stderr).toContain(
      "qwen-beta:latest is of the qwen family, the Coding model's (qwen); the Review model must be of another family",
    );
    const list = await sekhemet(["models", "list"], p);
    expect(list.stdout).not.toMatch(/^reviewer: qwen-beta/m);
    expect(list.stdout).toMatch(/^reviewer: (unassigned|.*unfilled)/m);
  }, 180_000);
});

describe("a qualification invalidated by a change to its combination (MD-N8-4)", () => {
  it("MD-N8-4: a person's new sampling for a qualified Worker marks its qualification invalidated, naming sampling as the change, and `queue` refuses it", async () => {
    const p = await project();
    const file = writeGguf(join(p.home, "Tiel-Coder.gguf"), {
      architecture: "qwen3moe",
      name: "Tiel Coder",
    });
    expect((await sekhemet(["models", "add", file, "--id", "tiel-coder"], p)).status).toBe(0);
    setUp(p, [{ qualify: "tiel-coder" }]);
    const ok = await sekhemet(["qualify", "--models", "tiel-coder", "--check"], p);
    expect(ok.status).toBe(0);
    // The model card's sampling, recorded after it qualified.
    const changed = await sekhemet(
      [
        "models",
        "add",
        file,
        "--id",
        "tiel-coder",
        "--sampling",
        "temperature=0.6,top_p=0.95,top_k=20,min_p=0",
      ],
      p,
    );
    expect(changed.status).toBe(0);
    const check = await sekhemet(["qualify", "--models", "tiel-coder", "--check"], p);
    expect(check.status).not.toBe(0);
    expect(check.stdout + check.stderr).toMatch(
      /invalidated[^\n]*sampling changed since it qualified/,
    );
    const queue = await sekhemet(["queue", "--worker", "tiel-coder"], p);
    expect(queue.status).toBe(1);
    expect(queue.stderr).toMatch(/sampling changed since it qualified/);
    expect(card(p, "c1")).toEqual({ status: "ready", attempts: 0 });
  }, 240_000);
});

describe("registering a person's GGUF with `models add` (MD-N12-9a, MD-N4-2a, MD-N14-41a)", () => {
  it("MD-N12-9a: `--sampling` records the model card's values and says so; an unknown key or an out-of-range value is refused with nothing recorded; without it the family's defaults are stated", async () => {
    const p = await project();
    const weights = join(p.home, "weights");
    mkdirSync(weights, { recursive: true });
    const file = writeGguf(join(weights, "Tiel-Coder.gguf"), {
      architecture: "qwen3moe",
      name: "Tiel Coder",
    });
    const unknown = await sekhemet(
      ["models", "add", file, "--id", "tiel-coder", "--sampling", "warmth=1"],
      p,
    );
    expect(unknown.status).not.toBe(0);
    expect(unknown.stdout + unknown.stderr).toMatch(/warmth/);
    expect(registryText(p)).not.toContain("tiel-coder");
    const range = await sekhemet(
      ["models", "add", file, "--id", "tiel-coder", "--sampling", "temperature=9"],
      p,
    );
    expect(range.status).not.toBe(0);
    expect(range.stdout + range.stderr).toMatch(/temperature/);
    expect(registryText(p)).not.toContain("tiel-coder");
    const plain = await sekhemet(["models", "add", file, "--id", "tiel-plain"], p);
    expect(plain.status).toBe(0);
    expect(plain.stdout).toMatch(
      /runs at temperature 0\.7, top_p 0\.8, top_k 20, min_p 0 \(the qwen family's defaults, not this model's card\)/,
    );
    const given = await sekhemet(
      [
        "models",
        "add",
        file,
        "--id",
        "tiel-coder",
        "--sampling",
        "temperature=0.6,top_p=0.95,top_k=20,min_p=0",
      ],
      p,
    );
    expect(given.status).toBe(0);
    expect(given.stdout).toMatch(
      /runs at temperature 0\.6, top_p 0\.95, top_k 20, min_p 0 \(the values given with --sampling\)/,
    );
    const entry = (JSON.parse(registryText(p)) as { models?: Record<string, unknown>[] }).models;
    const recorded = JSON.stringify(entry ?? JSON.parse(registryText(p)));
    expect(recorded).toContain('"temperature":0.6');
    expect(recorded).toContain('"topP":0.95');
  }, 180_000);

  it("MD-N4-2a: `models add` of a gpt-oss GGUF records that its reasoning cannot be turned off and its lowest level, and says so", async () => {
    const p = await project();
    const file = writeGguf(join(p.home, "gpt-oss-20b-Q4_K_M.gguf"), {
      architecture: "gpt-oss",
      name: "gpt-oss-20b",
    });
    const added = await sekhemet(["models", "add", file, "--id", "gpt-oss-20b"], p);
    expect(added.status).toBe(0);
    expect(added.stdout).toMatch(
      /gpt-oss-20b cannot turn its reasoning off \(architecture gpt-oss\): a request for none thinks at low/,
    );
    const text = registryText(p);
    expect(text).toContain('"cannotDisable": true');
    expect(text).toMatch(/"floor": "low"/);
  }, 180_000);

  it("MD-N14-41a: `doctor` checks a managed model's weights at the registry's recorded copy, not its shipped file name", async () => {
    const p = await project();
    const models = join(p.home, "models");
    mkdirSync(models, { recursive: true });
    const env = { SEKHEMET_MODELS_DIR: models };
    const before = await sekhemet(["doctor"], p, env);
    expect(before.stdout + before.stderr).toMatch(/qwen3\.8-27b [^;]*\([^)]*models\//);
    // The Planner's weights, stored under another name outside the models folder.
    const file = writeGguf(join(p.home, "Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf"), {
      architecture: "qwen3",
      name: "Qwen3.8 27B",
    });
    const added = await sekhemet(["models", "add", file, "--id", "qwen3.8-27b"], p, env);
    expect(added.status).toBe(0);
    const after = await sekhemet(["doctor"], p, env);
    expect(after.stdout + after.stderr).not.toMatch(/qwen3\.8-27b [^;]*\([^)]*models\//);
  }, 240_000);
});
