import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CardStore, type CreateCardInput, type EventLog } from "@sekhemet/kernel";
import { NodeGitSyncAdapter } from "@sekhemet/sync";
import { openLocalLedger } from "../../src/ledger_cmds.js";
import { g2Dirs, g2Env } from "./g2_cli.js";
import { writeTree } from "./g2_project.js";

/**
 * A card's checks as a person runs them, for the gates, worker-loop and
 * runtime entry-point tests (FINISH_LINE_PLAN C2d, FINDINGS_C1 TST-01): a
 * real repository and ledger, the card's real worktree under
 * `.sekhemet/worktrees/<card>` holding what the card wrote, and
 * `sekhemet gate <card>` (`g4_queue.ts` `gateCard`) spawned as the built binary
 * (`apps/harness/dist/index.js`), which runs the card run's own verification
 * (gates rule 8, T1). No model is reached.
 */
export interface GateProject {
  repo: string;
  home: string;
  env: Record<string, string>;
  /** The card's worktree. */
  worktree: string;
  git: (...args: string[]) => string;
}

export async function gateProject(opts: {
  /** The base's files, committed on `branch`. */
  files: Record<string, string>;
  /** What the card wrote in its worktree (not committed). */
  card?: Record<string, string>;
  /** Files the card removed from its worktree. */
  removed?: string[];
  /** The integration branch (default `main`). */
  branch?: string;
  cardInput?: Partial<CreateCardInput>;
  seed?: (store: CardStore, log: EventLog) => Promise<void>;
  /** Commit the card's files on its branch (a checkpoint) instead of leaving them untracked. */
  commitCard?: boolean;
}): Promise<GateProject> {
  const where = g2Dirs();
  const repo = where.cwd;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  const branch = opts.branch ?? "main";
  git("init", "-q", "-b", branch);
  git("config", "user.name", "Jane Doe");
  git("config", "user.email", "jane@example.com");
  writeTree(repo, { ".gitignore": ".sekhemet/\nnode_modules/\n", ...opts.files });
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  const { db, log } = openLocalLedger(repo);
  try {
    const store = new CardStore(db, log);
    await store.createCard({
      id: "c1",
      tier: "story",
      title: "Card one",
      scopeFiles: ["src/**"],
      ...opts.cardInput,
    });
    await opts.seed?.(store, log);
  } finally {
    db.close();
  }
  const worktree = await new NodeGitSyncAdapter(repo).createWorktree("c1", branch, "Card one");
  writeTree(worktree, opts.card ?? {});
  for (const f of opts.removed ?? []) execFileSync("git", ["rm", "-q", f], { cwd: worktree });
  if (opts.commitCard) {
    execFileSync("git", ["add", "-A"], { cwd: worktree });
    execFileSync("git", ["commit", "-q", "-m", "card"], { cwd: worktree });
  }
  return { repo, home: where.home, env: g2Env(where.home), worktree, git };
}

/** The evidence bundles a card run wrote (`ev_*.json`), oldest attempt first; one card's when named. */
export function evidenceBundles(repo: string, card?: string): Evidence[] {
  const dir = join(repo, ".sekhemet", "evidence");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^ev_.*\.json$/.test(f))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Evidence)
    .filter((e) => card === undefined || e.cardId === card)
    .sort(
      (a, b) => a.attempt - b.attempt || String(a.createdAt).localeCompare(String(b.createdAt)),
    );
}

/** A card's latest evidence bundle (`latest-<card>.json`), as the dashboard reads it. */
export function latestEvidence(repo: string, card: string): Evidence | undefined {
  const f = join(repo, ".sekhemet", "evidence", `latest-${card}.json`);
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Evidence) : undefined;
}

export interface Outcome {
  gate: string;
  rung: string;
  layer: string;
  passed: boolean;
  skipped?: boolean;
  unavailable?: boolean;
  cached?: boolean;
  reason?: string;
  note?: string;
  partial?: { file: string; reason: string; baselined?: boolean }[];
  superseded?: { test: string; staged: string[] }[];
  [k: string]: unknown;
}

/** The evidence bundle's fields these tests read (gates rule 35). */
export interface Evidence {
  id: string;
  cardId: string;
  attempt: number;
  createdAt?: string;
  passed: boolean;
  stopReason: string;
  rungResults: Outcome[];
  failures: {
    gate?: string;
    rung: string;
    location: { file: string; line?: number };
    minimalRepro: string;
    suggestedAction: string;
    errorExcerpt: string;
    [k: string]: unknown;
  }[];
  advisories: string[];
  skipped: { gate: string; reason: string }[];
  unavailable: { gate: string; reason: string }[];
  artifacts: { kind?: string; path?: string; [k: string]: unknown }[];
  settings: Record<string, unknown>;
  steps: Record<string, unknown>[];
  gatesConfigSha256: string;
  [k: string]: unknown;
}
