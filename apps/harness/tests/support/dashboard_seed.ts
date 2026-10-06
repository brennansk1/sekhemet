import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { NodeGitSyncAdapter } from "@sekhemet/sync";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { recordLedgerRun } from "../../src/ledger_evidence.js";

/**
 * A seeded board for the dashboard's entry-point tests (C2d, FINDINGS_C1
 * TST-01, TST-02): a real git repository, a real SQLite ledger in it, and
 * cards in every stored state, written through the kernel's own store as the
 * planner and the runner would leave them. The spec starts the dashboard
 * server over it and drives it in Chromium; nothing here loads a model.
 */
export interface SeededBoard {
  dir: string;
  db: DatabaseSync;
  log: EventLog;
  store: CardStore;
  /** The project every seeded card belongs to. */
  project: string;
  /** A second project, holding one card, so the switchers have a choice. */
  other: string;
  cleanup: () => void;
}

/** The fourteen checks of five families an In review card ran (DB-N1-1). */
export const FOURTEEN_GATES: { gate: string; rung: string; layer: string; passed: boolean }[] = [
  { gate: "unit", rung: "test", layer: "functional", passed: false },
  { gate: "acceptance", rung: "test", layer: "functional", passed: true },
  { gate: "mutation", rung: "test", layer: "functional", passed: true },
  { gate: "lint", rung: "hygiene", layer: "functional", passed: true },
  { gate: "format", rung: "hygiene", layer: "functional", passed: true },
  { gate: "types", rung: "hygiene", layer: "functional", passed: true },
  { gate: "size", rung: "hygiene", layer: "functional", passed: true },
  { gate: "secrets", rung: "security", layer: "security", passed: true },
  { gate: "osv", rung: "security", layer: "security", passed: true },
  { gate: "semgrep", rung: "security", layer: "security", passed: true },
  { gate: "licence", rung: "security", layer: "security", passed: true },
  { gate: "coverage", rung: "quality", layer: "quality", passed: true },
  { gate: "dead", rung: "quality", layer: "quality", passed: true },
  { gate: "a11y", rung: "visual", layer: "visual", passed: true },
];

export function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

/** Write an evidence bundle the server reads as a card's latest (`latest-<id>.json`). */
export function writeEvidence(dir: string, cardId: string, body: Record<string, unknown>): void {
  const evidence = join(dir, ".sekhemet", "evidence");
  mkdirSync(evidence, { recursive: true });
  writeFileSync(
    join(evidence, `latest-${cardId}.json`),
    JSON.stringify({
      id: `ev_${cardId}`,
      cardId,
      attempt: 1,
      createdAt: new Date(Date.now() - 3600_000).toISOString(),
      passed: true,
      failures: [],
      skipped: [],
      unavailable: [],
      stopReason: "passed",
      turnsUsed: 3,
      durationMs: 1000,
      rungResults: [],
      ...body,
    }),
  );
}

/**
 * The board: a project with a card in each stored state (two In review, one
 * On hold, one Won't do), points on each, the Agent delegated on one and a
 * person on another, an epic, and a second project with one card.
 */
export async function seedBoard(prefix = "sek-entry-"): Promise<SeededBoard> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Ada Lovelace");
  git(dir, "config", "user.email", "ada@example.com");
  writeFileSync(join(dir, "README.md"), "# Timesheets\n");
  writeFileSync(join(dir, ".gitignore"), ".sekhemet/\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "seed");
  // Kernel rule 38a (K-N12-6): project roots never nest, so the second is beside the first.
  const otherRoot = `${dir}-other`;
  mkdirSync(otherRoot, { recursive: true });
  mkdirSync(join(dir, ".sekhemet"), { recursive: true });
  const db = new DatabaseSync(join(dir, ".sekhemet", "events.db"));
  initSchema(db);
  const log = new EventLog(db);
  const store = new CardStore(db, log);
  const project = (await store.ensureProject({ name: "Timesheets", rootPath: dir })).id;
  const other = (await store.ensureProject({ name: "Recipes", rootPath: otherRoot })).id;
  const card = async (
    id: string,
    title: string,
    status: string,
    extra: Record<string, unknown> = {},
  ) => {
    const start = status === "backlog" || status === "ready" ? status : "ready";
    await store.createCard({
      id,
      tier: "task",
      title,
      status: start as never,
      projectId: project,
      scopeFiles: [`src/${id}.ts`],
      ...extra,
    });
    // A card is never created further along (the transition law): moved there as setup.
    if (status !== start)
      await store.updateCardStatus(id, status as never, "setup", "harness", { override: true });
  };
  await card("card_bk1", "Import last month's timesheets", "backlog", { estimate: 3 });
  await card("card_td1", "Pay public holidays at double time", "ready", {
    estimate: 2,
    delegate: { kind: "worker" },
  });
  await card("card_td2", "Plan the overtime report", "planning", {
    estimate: 1,
    delegate: { kind: "person", id: "local:grace" },
  });
  await card("card_ip1", "Work out the pay period of a date", "in_progress", { estimate: 5 });
  await card("card_vf1", "Round minutes to the quarter hour", "verify", { estimate: 1 });
  await card("card_rv1", "Show the weekly total on the timesheet", "review", { estimate: 2 });
  await card("card_rv2", "Flag hours past 40 in a week", "review", { estimate: 3 });
  await card("card_dn1", "Export a week's entries as CSV", "done", { estimate: 8 });
  await card("card_pk1", "Let a manager approve a week", "parked", { estimate: 2 });
  await card("card_rj1", "Print timesheets on paper", "rejected", { estimate: 1 });
  await store.createCard({
    id: "card_o1",
    tier: "task",
    title: "Save a recipe",
    status: "backlog",
    projectId: other,
  });
  return {
    dir,
    db,
    log,
    store,
    project,
    other,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
      rmSync(otherRoot, { recursive: true, force: true });
    },
  };
}

/**
 * A fresh browser context at `width`, the first-run question answered (this
 * browser writes code), optionally the project chosen and motion reduced.
 */
export async function openContext(
  browser: Browser,
  width: number,
  opts: { project?: string; reducedMotion?: boolean; height?: number } = {},
): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({
    viewport: { width, height: opts.height ?? 900 },
    ...(opts.reducedMotion ? { reducedMotion: "reduce" as const } : {}),
  });
  await ctx.addInitScript((p) => {
    try {
      if (!sessionStorage.getItem("seeded")) {
        localStorage.setItem("sekhemet-role", "code");
        if (p) localStorage.setItem("sekhemet-project", p);
      }
      sessionStorage.setItem("seeded", "1");
    } catch {}
  }, opts.project ?? null);
  return { ctx, page: await ctx.newPage() };
}

/**
 * A card a person can really accept: built on its own branch by a
 * checkpoint commit, its passing evidence recorded on the ledger, in Review
 * (as `dashboard_accept.spec.ts` builds one). Accepting it merges to main.
 */
export async function acceptableCard(seed: SeededBoard, id: string, title: string): Promise<void> {
  const adapter = new NodeGitSyncAdapter(seed.dir);
  await seed.store.createCard({
    id,
    tier: "story",
    title,
    status: "ready",
    projectId: seed.project,
    scopeFiles: ["src/**"],
  });
  const wt = await adapter.createWorktree(id, "main", title);
  mkdirSync(join(wt, "src"), { recursive: true });
  writeFileSync(join(wt, "src", `${id}.ts`), `export const ${id} = 2;\n`);
  await adapter.commitCheckpoint({
    cardId: id,
    step: 1,
    gateStatus: "pass",
    agentModel: "stand-in",
    agentHarness: "sekhemet",
    agentRole: "implementer",
  });
  const evidence = {
    id: `ev_${id}`,
    cardId: id,
    attempt: 1,
    passed: true,
    rungResults: [{ gate: "unit", rung: "test", layer: "functional", passed: true, exitCode: 0 }],
    filesTouched: [`src/${id}.ts`],
    linesAdded: 1,
    linesRemoved: 0,
    diff: [
      `diff --git a/src/${id}.ts b/src/${id}.ts`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/src/${id}.ts`,
      "@@ -0,0 +1 @@",
      `+export const ${id} = 2;`,
      "",
    ].join("\n"),
    settings: { modelId: "stand-in" },
    stopReason: "gate_passed",
    repoState: await adapter.getRepoStateHash(id),
  };
  const body = `${JSON.stringify(evidence, null, 2)}\n`;
  const dir = join(seed.dir, ".sekhemet", "evidence");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `ev_${id}.json`), body);
  writeFileSync(join(dir, `latest-${id}.json`), body);
  await recordLedgerRun(seed.store, {
    cardId: id,
    modelId: "stand-in",
    passed: true,
    stopReason: "gate_passed",
    evidenceId: `ev_${id}`,
    path: join(".sekhemet", "evidence", `ev_${id}.json`),
    body,
    filesTouched: [`src/${id}.ts`],
  });
  await seed.store.updateCardStatus(id, "review", "verified", "harness", { override: true });
}

/**
 * Break the ledger's hash chain at one entry, as a hand edit of the file
 * would (DB-N2-2): a card's recorded title is changed in place, the payload
 * still well formed. Returns the edited entry's seq.
 */
export function tamperLedger(seed: SeededBoard, cardId = "card_bk1"): number {
  const raw = new DatabaseSync(join(seed.dir, ".sekhemet", "events.db"));
  try {
    raw.exec("DROP TRIGGER IF EXISTS events_no_update");
    const row = raw
      .prepare("SELECT seq, payload FROM events WHERE card_id = ? AND type = 'card/created'")
      .get(cardId) as { seq: number; payload: string };
    const payload = JSON.parse(row.payload) as { title?: string };
    payload.title = `${payload.title ?? ""} (edited by hand)`;
    raw
      .prepare("UPDATE events SET payload = ? WHERE seq = ?")
      .run(JSON.stringify(payload), row.seq);
    return row.seq;
  } finally {
    raw.close();
  }
}
