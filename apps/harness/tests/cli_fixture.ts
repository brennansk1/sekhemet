import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore } from "@sekhemet/kernel";
import { ModelRegistry, ModelRoster, QUALIFICATION_SUITE_VERSION } from "@sekhemet/models";
import { NodeGitSyncAdapter } from "@sekhemet/sync";
import { afterEach, vi } from "vitest";
import { recordReviewOpened } from "../src/accept.js";
import { openLocalLedger } from "../src/ledger_cmds.js";
import { recordLedgerRun } from "../src/ledger_evidence.js";
import { qualificationCombination } from "../src/qualify.js";

/**
 * The command line's entry point for tests (surface S10, NEW-surface-10):
 * the built binary (`apps/harness/dist/index.js`) spawned in an empty
 * working directory and an empty home, a scripted Worker at the HTTP
 * boundary, and an issue waiting in Review. Shared by `cli_exit.spec.ts`,
 * `cli_json.spec.ts` and `cli_accept_ack.spec.ts`.
 */
export const BIN = resolve(import.meta.dirname, "../dist/index.js");
export const VERSION = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8"),
).version as string;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** An empty working directory and an empty home, so any file written shows. */
export function sandboxDirs(): { cwd: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "sek-cli-exit-"));
  dirs.push(root);
  const cwd = join(root, "cwd");
  const home = join(root, "home");
  mkdirSync(cwd);
  mkdirSync(home);
  return { cwd, home };
}

export function sekhemet(args: string[], where: { cwd: string; home: string }) {
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

/** The Worker's model tag; every request for it is answered by the preload below. */
export const SCRIPTED_WORKER = "scripted-worker:latest";

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
export async function scriptedWorkerProject(
  where: { cwd: string; home: string },
  gateArgs: string[] = ["-e", "process.exit(0)"],
) {
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
    `[project]\nmax_files = 3\nmax_diff_lines = 200\n\n[[gate]]\nid = "unit"\nrung = "test"\nlayer = "functional"\ncommand = "node"\nargs = ${JSON.stringify(gateArgs)}\ntimeout_s = 60\nparser = "generic"\n`,
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

/**
 * A repository with one card built on its branch, verified, its evidence on
 * the ledger and its files looked at, in Review — the state `accept` acts on.
 */
export async function cardInReview(
  where: { cwd: string },
  id: string,
  opts: { rungResults?: Record<string, unknown>[] } = {},
): Promise<string> {
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
    rungResults: opts.rungResults ?? [
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
