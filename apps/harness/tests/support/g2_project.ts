import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CardStore, type CreateCardInput, type EventLog } from "@sekhemet/kernel";
import type { ModelRole } from "@sekhemet/models";
import { openLocalLedger } from "../../src/ledger_cmds.js";
import { g2Env } from "./g2_cli.js";
import { SCRIPTED_MODEL, scriptedModel } from "./g2_model.js";

/**
 * A real repository with Ready cards, one gate, the scripted model recorded
 * as qualified for the Worker's exact combination on this host (MD-N8-1),
 * and the environment the spawned binary runs with (the C2d entry-point
 * tests of design-stage, measurement and context). Like `cli_fixture.ts`'s
 * `scriptedWorkerProject`, with the files, cards, gate and ledger set-up a
 * test names; the Worker is `g2_model.ts`'s recording scripted model.
 */
/** Records the qualifications in a plain Node process (`g2_qualify.mjs`). */
const QUALIFY = resolve(import.meta.dirname, "g2_qualify.mjs");

export interface G2Project {
  repo: string;
  home: string;
  env: Record<string, string>;
  preload: string;
  record: string;
}

export function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
}

export function gatesToml(gateArgs: string[], id = "unit"): string {
  return `[project]\nmax_files = 3\nmax_diff_lines = 200\n\n[[gate]]\nid = "${id}"\nrung = "test"\nlayer = "functional"\ncommand = "node"\nargs = ${JSON.stringify(gateArgs)}\ntimeout_s = 60\nparser = "generic"\n`;
}

export async function g2Project(
  where: { cwd: string; home: string },
  opts: {
    files?: Record<string, string>;
    cards: CreateCardInput[];
    gateArgs?: string[];
    /** Ledger set-up after the cards exist (rules, dossier entries, …). */
    seed?: (store: CardStore, log: EventLog) => Promise<void>;
    /**
     * The qualifications recorded for the scripted model: by default one, as
     * the Coding model under this build's prompt version. `contextVersion`
     * records it under another build's version (CX-N6-1); `role` for another role.
     */
    qualifyAs?: { role?: ModelRole; contextVersion?: string }[];
  },
): Promise<G2Project> {
  const repo = where.cwd;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Jane Doe");
  git("config", "user.email", "jane@example.com");
  writeTree(repo, {
    ".gitignore": ".sekhemet/\n",
    ".sekhemet/gates.toml": gatesToml(opts.gateArgs ?? ["-e", "process.exit(0)"]),
    ...(opts.files ?? { "src/a.ts": "" }),
  });
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  const { db, log } = openLocalLedger(repo);
  try {
    const store = new CardStore(db, log);
    for (const c of opts.cards) await store.createCard(c);
    await opts.seed?.(store, log);
  } finally {
    db.close();
  }
  const base = g2Env(where.home);
  // A scripted model is reached over HTTP: the load guard would refuse it.
  const { SEKHEMET_MODEL_LOADS: _off, ...env } = base;
  // The qualifications, computed by the built modules in their own process.
  execFileSync(
    process.execPath,
    [QUALIFY, SCRIPTED_MODEL, JSON.stringify(opts.qualifyAs ?? [{}])],
    { env, encoding: "utf8" },
  );
  const { preload, record } = scriptedModel(where.home);
  return { repo, home: where.home, env, preload, record };
}
