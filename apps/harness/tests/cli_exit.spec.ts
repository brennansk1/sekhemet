import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore } from "@sekhemet/kernel";
import { ModelRegistry, ModelRoster, QUALIFICATION_SUITE_VERSION } from "@sekhemet/models";
import { NodeGitSyncAdapter } from "@sekhemet/sync";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordReviewOpened } from "../src/accept.js";
import { runExitCode } from "../src/front_door.js";
import { openLocalLedger } from "../src/ledger_cmds.js";
import { recordLedgerRun } from "../src/ledger_evidence.js";
import { qualificationCombination } from "../src/qualify.js";

/**
 * surface S10 — a command line scripts can trust. Tested by spawning the built
 * binary (`apps/harness/dist/index.js`), not by calling functions.
 */
const BIN = resolve(import.meta.dirname, "../dist/index.js");
const VERSION = JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8"))
  .version as string;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** An empty working directory and an empty home, so any file written shows. */
function sandboxDirs(): { cwd: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "sek-cli-exit-"));
  dirs.push(root);
  const cwd = join(root, "cwd");
  const home = join(root, "home");
  mkdirSync(cwd);
  mkdirSync(home);
  return { cwd, home };
}

function sekhemet(args: string[], where: { cwd: string; home: string }) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: where.cwd,
    encoding: "utf8",
    timeout: 20_000,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: where.home,
      SEKHEMET_CONFIG_DIR: join(where.home, ".sekhemet"),
      SEKHEMET_USER_CONFIG: "/nonexistent/sekhemet-test-user-config.toml",
      BROWSER: "false",
    },
  });
}

describe("S10: a command line scripts can trust", () => {
  it("SUR-13: --version and -v print the version, write no file, start no server, exit 0", () => {
    for (const flag of ["--version", "-v"]) {
      const where = sandboxDirs();
      const r = sekhemet([flag], where);
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(VERSION);
      expect(readdirSync(where.cwd)).toEqual([]);
      expect(readdirSync(where.home)).toEqual([]);
    }
  });

  it("SUR-14: an uncaught error is printed and exits 1", () => {
    const where = sandboxDirs();
    // A file where the repository should be: the ledger cannot be opened.
    const notADir = join(where.cwd, "file");
    writeFileSync(notADir, "not a repository\n");
    const r = sekhemet(["dev", "log", "--repo", notADir], where);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Error|ENOTDIR|not a directory/i);
  });

  it("SUR-15: an unknown flag is named and exits 2, writing nothing", () => {
    const where = sandboxDirs();
    const r = sekhemet(["doctor", "--no-such-flag"], where);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--no-such-flag");
    expect(readdirSync(where.cwd)).toEqual([]);
    const eq = sekhemet(["board", "--terminl=1"], where);
    expect(eq.status).toBe(2);
    expect(eq.stderr).toContain("--terminl");
  });

  it("SUR-16: run exits 1 when the card ends parked or failed, 0 in Review or Done", () => {
    expect(runExitCode("review")).toBe(0);
    expect(runExitCode("done")).toBe(0);
    expect(runExitCode("parked")).toBe(1);
    expect(runExitCode("ready")).toBe(1);
    expect(runExitCode("in_progress")).toBe(1);
  });

  it("SUR-16, spawned: a scripted Worker that finishes the card exits 0 in Review; one that does nothing exits 1", async () => {
    for (const mode of ["finish", "stall"] as const) {
      const where = sandboxDirs();
      const env = await scriptedWorkerProject(where);
      const r = spawnSync(
        process.execPath,
        ["--import", env.preload, BIN, "run", "c1", "--worker", SCRIPTED_WORKER],
        {
          cwd: where.cwd,
          encoding: "utf8",
          timeout: 120_000,
          env: { ...env.vars, SCRIPTED_WORKER_MODE: mode },
        },
      );
      const { db, log } = openLocalLedger(where.cwd);
      const status = (await new CardStore(db, log).getCard("c1"))?.status;
      db.close();
      if (mode === "finish") {
        expect(status, r.stdout + r.stderr).toBe("review");
        expect(r.stdout).toMatch(/turn: write_file, finish_card/);
        expect(r.status, r.stdout + r.stderr).toBe(0);
      } else {
        // The Worker was reached and ran out of turns; nothing refused it.
        expect(r.stdout).toMatch(/turn: \(no tool calls\)/);
        expect(r.stdout).toMatch(/Issue c1 stopped: /);
        expect(status).not.toBe("review");
        expect(status).not.toBe("done");
        expect(r.status, r.stdout + r.stderr).toBe(1);
      }
    }
  }, 300_000);

  it("RUN-9: `run` makes the supervisor's start-up pass under its lease, sweeping a crashed attempt back to Ready", async () => {
    const where = sandboxDirs();
    const env = await scriptedWorkerProject(where);
    {
      const { db, log } = openLocalLedger(where.cwd);
      const store = new CardStore(db, log);
      await store.createCard({
        id: "c2",
        tier: "story",
        title: "Crashed",
        scopeFiles: ["src/a.ts"],
      });
      await store.updateCardStatus("c2", "in_progress", "a runner was killed", "harness", {
        override: true,
      });
      await store.runs.startAttempt({ cardId: "c2", attemptNumber: 1, modelId: "m" });
      db.close();
    }
    const r = spawnSync(
      process.execPath,
      ["--import", env.preload, BIN, "run", "c1", "--worker", SCRIPTED_WORKER],
      {
        cwd: where.cwd,
        encoding: "utf8",
        timeout: 120_000,
        env: { ...env.vars, SCRIPTED_WORKER_MODE: "finish" },
      },
    );
    expect(r.stdout, r.stderr).toMatch(/Crashed attempt of c2 .* swept: back to Ready/);
    const { db, log } = openLocalLedger(where.cwd);
    try {
      expect((await new CardStore(db, log).getCard("c2"))?.status).toBe("ready");
    } finally {
      db.close();
    }
  }, 300_000);
});

/** The Worker's model tag; every request for it is answered by the preload below. */
const SCRIPTED_WORKER = "scripted-worker:latest";

/**
 * A scripted Worker at the HTTP boundary: loaded with `node --import` into
 * the spawned binary, it answers every request to the Ollama address itself
 * (the machine's real Ollama is never reached). In `finish` mode the first
 * Worker turn writes the file and finishes the card; otherwise, and on every
 * other call, the model says nothing.
 */
const PRELOAD = `
const real = globalThis.fetch;
const MODEL = ${JSON.stringify(SCRIPTED_WORKER)};
let finished = false;
const json = (b) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith("http://127.0.0.1:11434")) return real(input, init);
  const path = new URL(url).pathname;
  if (path === "/api/tags" || path === "/api/ps")
    return json({ models: [{ name: MODEL, model: MODEL, size: 1 }] });
  if (path !== "/api/chat") return json({});
  const body = JSON.parse(String(init?.body ?? "{}"));
  const act = process.env.SCRIPTED_WORKER_MODE === "finish" && !finished && (body.tools ?? []).length > 0;
  if (act) finished = true;
  const message = act
    ? { role: "assistant", content: "", tool_calls: [
        { function: { name: "write_file", arguments: { path: "src/a.ts", content: "export const a = 1;\\n" } } },
        { function: { name: "finish_card", arguments: {} } } ] }
    : { role: "assistant", content: "" };
  const final = { model: MODEL, message, done: true, done_reason: "stop", prompt_eval_count: 10, eval_count: 5 };
  return body.stream ? new Response(JSON.stringify(final) + "\\n") : json(final);
};
`;

/**
 * A repository with one Ready card and one trivially passing gate, the
 * scripted Worker recorded as qualified for its exact combination on this
 * host (MD-N8-1), and the environment the spawned binary runs with.
 */
async function scriptedWorkerProject(where: { cwd: string; home: string }) {
  const repo = where.cwd;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Jane Doe");
  git("config", "user.email", "jane@example.com");
  mkdirSync(join(repo, "src"));
  mkdirSync(join(repo, ".sekhemet"));
  writeFileSync(join(repo, "src", "a.ts"), "");
  writeFileSync(
    join(repo, ".sekhemet", "gates.toml"),
    `[project]\nmax_files = 3\nmax_diff_lines = 200\n\n[[gate]]\nid = "unit"\nrung = "test"\nlayer = "functional"\ncommand = "node"\nargs = ["-e", "process.exit(0)"]\ntimeout_s = 30\nparser = "generic"\n`,
  );
  writeFileSync(join(repo, ".gitignore"), ".sekhemet/\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  const { db, log } = openLocalLedger(repo);
  await new CardStore(db, log).createCard({
    id: "c1",
    tier: "story",
    title: "Write a",
    scopeFiles: ["src/a.ts"],
    stepBudget: 3,
    spec: "Export a constant named a from src/a.ts",
  });
  db.close();
  const configDir = join(where.home, ".sekhemet");
  const vars = {
    PATH: process.env.PATH ?? "",
    HOME: where.home,
    SEKHEMET_CONFIG_DIR: configDir,
    SEKHEMET_MODEL_REGISTRY: join(configDir, "models.json"),
    SEKHEMET_USER_CONFIG: "/nonexistent/sekhemet-test-user-config.toml",
    BROWSER: "false",
  };
  // The Worker's combination, resolved as the binary resolves it, recorded as qualified.
  for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v);
  try {
    const registry = new ModelRegistry(vars.SEKHEMET_MODEL_REGISTRY);
    const adapter = new ModelRoster({ registry }).resolve(SCRIPTED_WORKER, "worker");
    registry.recordCombinationQualification(
      adapter.modelId,
      qualificationCombination(adapter, { registry }),
      {
        suiteVersion: QUALIFICATION_SUITE_VERSION,
        passRate: 1,
        status: "qualified",
        toolCallChecks: true,
      },
    );
  } finally {
    vi.unstubAllEnvs();
  }
  const preload = join(where.home, "scripted_worker.mjs");
  writeFileSync(preload, PRELOAD);
  return { vars, preload };
}

describe("NEW-surface-5: one recorded run profile, from the command line", () => {
  it("SUR-44, SUR-45: a queue whose flags cannot resolve to one profile does not start, exit 2", () => {
    const where = sandboxDirs();
    spawnSync("git", ["init", "-q"], { cwd: where.cwd });
    const r = sekhemet(["queue", "--repo", where.cwd, "--profile", "full"], where);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--profile/);
    expect(r.stdout).not.toMatch(/Profile full/);
  });
});

/**
 * A repository with one card built on its branch, verified, its evidence on
 * the ledger and its files looked at, in Review — the state `accept` acts on.
 */
async function cardInReview(where: { cwd: string }, id: string): Promise<string> {
  const repo = where.cwd;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  const write = (root: string, rel: string, text: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Jane Doe");
  git("config", "user.email", "jane@example.com");
  write(repo, "src/a.ts", "export const a = 1;\n");
  write(repo, ".gitignore", ".sekhemet/\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  const { db, log } = openLocalLedger(repo);
  const store = new CardStore(db, log);
  const board = new BoardServiceImpl(store);
  const me = log.localPrincipal();
  await store.createCard({ id, tier: "story", title: `Card ${id}`, scopeFiles: ["src/**"] });
  await store.delegateCard(id, { kind: "worker" }, me);
  const adapter = new NodeGitSyncAdapter(repo);
  const wt = await adapter.createWorktree(id, "main", `Card ${id}`);
  write(wt, "src/b.ts", "export const b = 2;\n");
  await adapter.commitCheckpoint({
    cardId: id,
    step: 1,
    gateStatus: "pass",
    agentModel: "scripted",
    agentHarness: "sekhemet",
    agentRole: "implementer",
  });
  const evidence = {
    id: `ev_${id}`,
    cardId: id,
    attempt: 1,
    passed: true,
    rungResults: [
      { gate: "unit", rung: "test", layer: "functional", passed: true, exitCode: 0, durationMs: 5 },
    ],
    filesTouched: ["src/b.ts"],
    linesAdded: 1,
    linesRemoved: 0,
    settings: { modelId: "scripted" },
    stopReason: "gate_passed",
    repoState: await adapter.getRepoStateHash(id),
  };
  const body = `${JSON.stringify(evidence, null, 2)}\n`;
  mkdirSync(join(repo, ".sekhemet", "evidence"), { recursive: true });
  writeFileSync(join(repo, ".sekhemet", "evidence", `${evidence.id}.json`), body);
  await recordLedgerRun(store, {
    cardId: id,
    modelId: "scripted",
    passed: true,
    stopReason: "gate_passed",
    evidenceId: evidence.id,
    path: join(".sekhemet", "evidence", `${evidence.id}.json`),
    body,
    filesTouched: evidence.filesTouched,
  });
  await store.updateCardStatus(id, "review", "verified", "harness", { override: true });
  const card = await store.getCard(id);
  if (!card) throw new Error(`no ${id}`);
  await recordReviewOpened({ repoPath: repo, cardStore: store, boardService: board }, card, [
    "src/b.ts",
  ]);
  db.close();
  return me;
}

describe("SUR-53: who may accept, from the command line", () => {
  it("with exactly one Accept-holder, accepts that person's own delegated card and exits 0", async () => {
    const where = sandboxDirs();
    await cardInReview(where, "c1");
    const r = sekhemet(["accept", "c1"], where);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Accepted c1/);
    const { db, log } = openLocalLedger(where.cwd);
    try {
      const store = new CardStore(db, log);
      expect((await store.getCard("c1"))?.status).toBe("done");
      const [accepted] = await store.cardEvents("c1", ["card/accepted"]);
      expect(accepted?.payload).toMatchObject({ independent: false });
    } finally {
      db.close();
    }
  });
});
