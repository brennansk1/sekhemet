#!/usr/bin/env node
/**
 * Record one fixture ledger, with its config.toml, per schema boundary
 * (FINISH_LINE_PLAN W8, C-18; kernel rule 38, K-N4-1..5; surface item 32).
 *
 *   node scripts/record_schema_fixtures.mjs [--only <name>]
 *
 * For each boundary below, the commit that first wrote that schema version is
 * checked out in a temporary `git worktree`, its own kernel is compiled there
 * (this checkout's TypeScript and dependencies linked in, nothing fetched),
 * and that build writes a small but complete ledger: a project, cards in
 * several states, an edit, a dependency, a checkpoint and a hold where the
 * build has one. The ledger is checkpointed into one file
 * (`packages/kernel/tests/fixtures/schemas/<name>.db`), beside the
 * configuration that release read (`<name>.config.toml`, with the key names
 * of its day) and what the old build itself saw (`<name>.json`: its schema
 * version, event count, chain head, and each card's id, status and title).
 * `packages/kernel/tests/upgrade.spec.ts` and
 * `apps/harness/tests/upgrade_release.spec.ts` load each one with this build.
 *
 * Recorded once and checked in; re-run only to add a boundary. The worktrees
 * are removed afterwards.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "packages", "kernel", "tests", "fixtures", "schemas");

/** The commit that first wrote each schema version, oldest first (`git log -- packages/kernel/src/schema.ts`). */
export const BOUNDARIES = [
  {
    name: "legacy-pre-migrations",
    commit: "028b592",
    note: "before numbered migrations (user_version 0)",
  },
  { name: "v15", commit: "18a3197", note: "B3.1: the transition law; owner and delegate" },
  { name: "v16", commit: "d3c1e08", note: "B3.2/B3.3: card configuration overrides" },
  { name: "v18", commit: "eb6776f", note: "B4.0b: supersedes, gate checks" },
  {
    name: "v21-previous-release",
    commit: "c59ed42",
    note: "the previous release: split depth, interface, criterion ids",
  },
];

const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });

/** The script each old build runs: its own kernel, writing the fixture. */
const RECORDER = `
const [kernelUrl, dbPath, expectedPath] = process.argv.slice(1);
const k = await import(kernelUrl);
const { DatabaseSync } = await import("node:sqlite");
const { writeFileSync } = await import("node:fs");
const db = new DatabaseSync(dbPath);
k.initSchema(db);
const log = new k.EventLog(db);
const store = new k.CardStore(db, log);
const tried = [];
const attempt = async (what, fn) => {
  try { await fn(); tried.push(what); } catch (err) { tried.push(what + " (not in this build: " + String(err.message ?? err).split("\\n")[0] + ")"); }
};
await attempt("project", () => store.ensureProject?.({ name: "fixture", rootPath: "/fixture/repo" }));
await store.createCard({ id: "card_epic", tier: "epic", title: "Timesheets" });
await store.createCard({ id: "card_a", tier: "story", title: "Record a shift", parentId: "card_epic", scopeFiles: ["src/shift.ts"] });
await store.createCard({ id: "card_b", tier: "story", title: "Overtime after 40 hours", parentId: "card_epic" });
await store.createCard({ id: "card_c", tier: "task", title: "Export to CSV" });
await attempt("edit", () => store.updateCard("card_c", { title: "Export the week to CSV" }));
await attempt("dependency", () => store.addDependency("card_b", "card_a"));
await attempt("ready", () => store.updateCardStatus("card_a", "ready", "planned"));
await attempt("in progress", () => store.updateCardStatus("card_a", "in_progress", "started"));
await attempt("checkpoint", () => store.recordCheckpoint({ cardId: "card_a", step: 1, gitRef: "0123456789abcdef0123456789abcdef01234567", gateStatus: "pass", agentModel: "fixture-coder", agentHarness: "sekhemet", agentRole: "implementer", createdAt: "2026-09-25T00:00:00.000Z" }));
await attempt("ready again", () => store.updateCardStatus("card_b", "ready", "planned"));
const version = db.prepare("PRAGMA user_version").get().user_version;
const events = db.prepare("SELECT COUNT(*) AS n FROM events").get().n;
const head = db.prepare("SELECT hash FROM events ORDER BY seq DESC LIMIT 1").get()?.hash ?? null;
const cards = db.prepare("SELECT id, status, title FROM cards ORDER BY id").all().map((c) => ({ ...c }));
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
db.exec("PRAGMA journal_mode = DELETE");
db.close();
writeFileSync(expectedPath, JSON.stringify({ schemaVersion: version, events, head, cards, recorded: tried }, null, 2) + "\\n");
`;

function configFor(commit) {
  let source = "";
  try {
    source = git("show", `${commit}:apps/harness/src/config.ts`);
  } catch {
    source = "";
  }
  // Surface item 25: [machine] hours became reserved_hours; the older key is what that release wrote.
  const hoursKey = source.includes("reserved_hours") ? "reserved_hours" : "hours";
  return [
    "# The configuration this release read, with the key names of its day.",
    "[machine]",
    `${hoursKey} = "09:00-17:00 Mon-Fri"`,
    "power_budget_kwh_day = 2",
    "",
    "[review]",
    "review_minutes_per_day = 45",
    "",
    "[network]",
    'mode = "offline"',
    "",
  ].join("\n");
}

function record(b) {
  const scratch = mkdtempSync(join(tmpdir(), `sek-fixture-${b.name}-`));
  const wt = join(scratch, "wt");
  git("worktree", "add", "--detach", "-q", wt, b.commit);
  try {
    // This checkout's toolchain and the kernel's one dependency, linked: nothing is fetched.
    symlinkSync(join(ROOT, "node_modules"), join(wt, "node_modules"));
    symlinkSync(
      join(ROOT, "packages", "kernel", "node_modules"),
      join(wt, "packages", "kernel", "node_modules"),
    );
    execFileSync(
      join(ROOT, "node_modules", ".bin", "tsc"),
      ["-b", join(wt, "packages", "kernel")],
      {
        stdio: "inherit",
      },
    );
    const db = join(OUT, `${b.name}.db`);
    for (const f of [db, `${db}-wal`, `${db}-shm`]) rmSync(f, { force: true });
    const expected = join(OUT, `${b.name}.json`);
    const kernel = pathToFileURL(join(wt, "packages", "kernel", "dist", "index.js")).href;
    execFileSync(process.execPath, ["--input-type=module", "-e", RECORDER, kernel, db, expected], {
      stdio: "inherit",
    });
    writeFileSync(join(OUT, `${b.name}.config.toml`), configFor(b.commit));
    console.log(`recorded ${b.name} from ${b.commit} (${b.note})`);
  } finally {
    git("worktree", "remove", "--force", wt);
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const only = process.argv.includes("--only")
    ? process.argv[process.argv.indexOf("--only") + 1]
    : undefined;
  mkdirSync(OUT, { recursive: true });
  for (const b of BOUNDARIES) if (!only || b.name === only) record(b);
  if (!existsSync(OUT)) process.exit(1);
}
