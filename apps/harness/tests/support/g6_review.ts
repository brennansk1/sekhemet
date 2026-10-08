import { type SpawnSyncReturns, execFileSync, spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, type EventLog } from "@sekhemet/kernel";
import { NodeGitSyncAdapter } from "@sekhemet/sync";
import { afterEach } from "vitest";
import { recordReviewOpened } from "../../src/accept.js";
import { openLocalLedger } from "../../src/ledger_cmds.js";
import { recordLedgerRun } from "../../src/ledger_evidence.js";
import { guardedImports, killTree, runTmpEnv, trackChild } from "./hygiene.js";

/**
 * Review and git through the built command (C2d, FINDINGS_C1 TST-01; review-git
 * and security, group G6): a real repository with cards built on their
 * branches and waiting in Review, a real ledger, and
 * `apps/harness/dist/index.js` spawned in it with an empty home and no model
 * loads. The cards are set up as the runner leaves them (as `cli_fixture.ts`'s
 * `cardInReview`, for any number of cards and files); every decision on them
 * is then made by the spawned command, as a person makes it.
 */
export const BIN = resolve(import.meta.dirname, "../../dist/index.js");

const roots: string[] = [];
afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
});

export const write = (base: string, rel: string, text: string) => {
  mkdirSync(dirname(join(base, rel)), { recursive: true });
  writeFileSync(join(base, rel), text);
};

export interface G6Repo {
  root: string;
  repo: string;
  home: string;
  git: (...args: string[]) => string;
  /** The environment the built command runs with here (`cliIn`, or a test's own spawn). */
  env: (opts?: CliOpts) => Record<string, string>;
  /** Open the ledger, run `fn`, close it. */
  ledger: <T>(
    fn: (s: { store: CardStore; log: EventLog; db: DatabaseSync }) => Promise<T> | T,
  ) => Promise<T>;
  /** Every byte of the person's checkout Accept must not touch: HEAD, index, files. */
  snapshot: () => Record<string, string>;
  /** Put the user configuration in place (`[team] mode = "team"`, `[network]` …). */
  userConfig: (toml: string) => void;
}

export interface CliOpts {
  env?: Record<string, string>;
  timeout?: number;
  cwd?: string;
}

/** An initialised repository (`src/a.ts`, `src/shared.ts`) with its ledger, under a fresh root. */
export function g6Repo(prefix = "sek-g6-"): G6Repo {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(root);
  const repo = join(root, "repo");
  const home = join(root, "home");
  mkdirSync(repo);
  mkdirSync(home);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Jane Doe");
  git("config", "user.email", "jane@example.com");
  write(repo, "src/a.ts", "export const a = 1;\n");
  write(repo, "src/shared.ts", "export const shared = 1;\n");
  write(repo, ".gitignore", ".sekhemet/\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  const userConfigPath = join(home, "user-config.toml");
  let hasUserConfig = false;
  const env = (opts: CliOpts = {}): Record<string, string> => ({
    PATH: process.env.PATH ?? "",
    HOME: home,
    SEKHEMET_CONFIG_DIR: join(home, ".sekhemet"),
    SEKHEMET_MODEL_REGISTRY: join(home, ".sekhemet", "models.json"),
    SEKHEMET_USER_CONFIG: hasUserConfig
      ? userConfigPath
      : "/nonexistent/sekhemet-test-user-config.toml",
    SEKHEMET_TRUST_DIR: join(home, "trust"),
    SEKHEMET_MODEL_LOADS: "off",
    SEKHEMET_KEYCHAIN: "off",
    BROWSER: "false",
    ...runTmpEnv(),
    ...opts.env,
  });
  const ledger = async <T>(
    fn: (s: { store: CardStore; log: EventLog; db: DatabaseSync }) => Promise<T> | T,
  ) => {
    const { db, log } = openLocalLedger(repo);
    try {
      return await fn({ store: new CardStore(db, log), log, db });
    } finally {
      db.close();
    }
  };
  const snapshot = () => {
    const out: Record<string, string> = {
      HEAD: readFileSync(join(repo, ".git", "HEAD"), "utf8"),
      index: readFileSync(join(repo, ".git", "index")).toString("base64"),
    };
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === ".git" || name === ".sekhemet") continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else out[relative(repo, path)] = readFileSync(path).toString("base64");
      }
    };
    walk(repo);
    return out;
  };
  const userConfig = (toml: string) => {
    writeFileSync(userConfigPath, toml);
    hasUserConfig = true;
  };
  return { root, repo, home, git, env, ledger, snapshot, userConfig };
}

/** The built command, run to its end in the repository: what a person types. */
export function cliIn(r: G6Repo, args: string[], opts: CliOpts = {}): SpawnSyncReturns<string> {
  // F31: the model-port guard first, always.
  return spawnSync(process.execPath, [...guardedImports(), BIN, ...args], {
    cwd: opts.cwd ?? r.repo,
    encoding: "utf8",
    timeout: opts.timeout ?? 60_000,
    env: r.env(opts),
  });
}

/**
 * The built command run to its end without blocking this process: for a test
 * whose own in-process server (a local GitHub, an egress fixture) the command talks to.
 */
export function cliAsync(
  r: G6Repo,
  args: string[],
  opts: CliOpts = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = trackChild(
    spawn(process.execPath, [...guardedImports(), BIN, ...args], {
      cwd: opts.cwd ?? r.repo,
      env: r.env(opts),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    }),
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (d) => {
    stdout += String(d);
  });
  child.stderr?.on("data", (d) => {
    stderr += String(d);
  });
  const timer = setTimeout(() => killTree(child), opts.timeout ?? 60_000);
  return new Promise((ok) =>
    child.once("close", (status) => {
      clearTimeout(timer);
      ok({ status, stdout, stderr });
    }),
  );
}

export interface Built {
  files: Record<string, string>;
  rungs?: Record<string, unknown>[];
  /** Record that the person looked at the files (Accept's own check); default true. */
  opened?: boolean;
  /** Who handed the card to the Worker; default the person at the terminal. */
  delegator?: string;
  base?: string;
  scope?: string[];
  /** The bundle's own verdict, when a test needs one its rungs do not give. */
  passed?: boolean;
  /** A stacked card: built on its parent's branch (review-git §2.5.5). */
  parent?: string;
  /** More fields of the evidence bundle (its diff, screenshots, coverage). */
  evidence?: Record<string, unknown>;
  /** Earlier attempts that failed, by stop reason, recorded before the passing one. */
  abandoned?: string[];
}

/**
 * Card `id` built on its branch from `base`, verified, its evidence on the
 * ledger and (by default) its files looked at, In review: as the runner and
 * the Review page leave a card a person may accept.
 */
export async function inReview(r: G6Repo, id: string, built: Built): Promise<void> {
  const { db, log } = openLocalLedger(r.repo);
  try {
    const store = new CardStore(db, log);
    const board = new BoardServiceImpl(store);
    const me = log.localPrincipal();
    await store.createCard({
      id,
      tier: "story",
      title: `Card ${id}`,
      scopeFiles: built.scope ?? ["src/**"],
      ...(built.parent ? { parentId: built.parent } : {}),
    });
    await store.delegateCard(id, { kind: "worker" }, built.delegator ?? me);
    const adapter = new NodeGitSyncAdapter(r.repo);
    const wt = await adapter.createWorktree(id, built.base ?? "main", `Card ${id}`, built.parent);
    for (const [f, t] of Object.entries(built.files)) write(wt, f, t);
    await adapter.commitCheckpoint({
      cardId: id,
      step: 1,
      gateStatus: "pass",
      agentModel: "scripted",
      agentHarness: "sekhemet",
      agentRole: "implementer",
    });
    const rungs = built.rungs ?? [
      {
        gate: "unit",
        rung: "test",
        layer: "functional",
        passed: true,
        exitCode: 0,
        durationMs: 12,
      },
    ];
    const evidence = {
      id: `ev_${id}`,
      cardId: id,
      attempt: 1,
      passed: built.passed ?? rungs.every((x) => x.passed === true || x.skipped === true),
      rungResults: rungs,
      filesTouched: Object.keys(built.files),
      linesAdded: Object.keys(built.files).length,
      linesRemoved: 0,
      settings: { modelId: "scripted" },
      stopReason: "gate_passed",
      repoState: await adapter.getRepoStateHash(id),
      ...built.evidence,
    };
    const body = `${JSON.stringify(evidence, null, 2)}\n`;
    mkdirSync(join(r.repo, ".sekhemet", "evidence"), { recursive: true });
    for (const [i, stopReason] of (built.abandoned ?? []).entries()) {
      const failed = `${JSON.stringify({ id: `ev_${id}_${i}`, cardId: id, passed: false, rungResults: [] })}\n`;
      writeFileSync(join(r.repo, ".sekhemet", "evidence", `ev_${id}_${i}.json`), failed);
      await recordLedgerRun(store, {
        cardId: id,
        modelId: "scripted",
        passed: false,
        stopReason: stopReason as Parameters<typeof recordLedgerRun>[1]["stopReason"],
        evidenceId: `ev_${id}_${i}`,
        path: join(".sekhemet", "evidence", `ev_${id}_${i}.json`),
        body: failed,
      });
    }
    writeFileSync(join(r.repo, ".sekhemet", "evidence", `${evidence.id}.json`), body);
    await recordLedgerRun(store, {
      cardId: id,
      modelId: "scripted",
      passed: evidence.passed,
      stopReason: "gate_passed",
      evidenceId: evidence.id,
      path: join(".sekhemet", "evidence", `${evidence.id}.json`),
      body,
      filesTouched: evidence.filesTouched,
    });
    await store.updateCardStatus(id, "review", "verified", "harness", { override: true });
    const card = await store.getCard(id);
    if (!card) throw new Error(`no ${id}`);
    if (built.opened !== false)
      await recordReviewOpened({ repoPath: r.repo, cardStore: store, boardService: board }, card, [
        ...Object.keys(built.files),
      ]);
  } finally {
    db.close();
  }
}

/** The person at the terminal, as the ledger names them. */
export async function localPrincipal(r: G6Repo): Promise<string> {
  return r.ledger(({ log }) => log.localPrincipal());
}

/** A card's status, read back from the ledger. */
export async function statusOf(r: G6Repo, id: string): Promise<string | undefined> {
  return r.ledger(async ({ store }) => (await store.getCard(id))?.status);
}

/** A card's events of the given types, in order: type, actor and payload. */
export async function eventsOf(
  r: G6Repo,
  id: string,
  types: string[],
): Promise<{ type: string; actor: string; seq: number; payload: Record<string, unknown> }[]> {
  return r.ledger(async ({ store }) =>
    (await store.cardEvents(id, types)).map((e) => ({
      type: e.type,
      actor: e.actor,
      seq: e.seq,
      payload: e.payload as Record<string, unknown>,
    })),
  );
}

/** The type of every event recorded after `seq`, in order. */
export async function typesSince(r: G6Repo, seq: number): Promise<string[]> {
  return r.ledger(({ db }) =>
    (
      db.prepare("SELECT type FROM events WHERE seq > ? ORDER BY seq").all(seq) as {
        type: string;
      }[]
    ).map((e) => e.type),
  );
}

/** The ledger's last seq. */
export async function lastSeq(r: G6Repo): Promise<number> {
  return r.ledger(
    ({ db }) =>
      (db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM events").get() as { n: number }).n,
  );
}
