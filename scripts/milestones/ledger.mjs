/**
 * B3's ledger checks (kernel rule 38, K-N4-5, runtime RUN-44): a real
 * `kill -9` of a process writing to a real SQLite WAL ledger, the chain and
 * the projections checked by this build's `sekhemet log` on restart; and an
 * older build's ledger compared row by row with what this build made of it.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isolatedEnv, runCli } from "./core.mjs";
import { makeRepo } from "./stand_in.mjs";

/** Every event row's seq, type and hash, read only. */
export function chainRows(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare("SELECT seq, type, hash FROM events ORDER BY seq").all();
  } finally {
    db.close();
  }
}

/** The seqs whose payload is not JSON. */
export function unreadablePayloads(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const bad = [];
    for (const r of db.prepare("SELECT seq, payload FROM events ORDER BY seq").iterate()) {
      try {
        JSON.parse(r.payload);
      } catch {
        bad.push(r.seq);
      }
    }
    return bad;
  } finally {
    db.close();
  }
}

/**
 * Is every row of `before` still there with its type and hash? Rows after
 * the old chain's end are counted as added (opening a ledger may append).
 */
export function compareChains(before, after) {
  const now = new Map(after.map((r) => [r.seq, r]));
  const problems = [];
  let kept = 0;
  for (const r of before) {
    const a = now.get(r.seq);
    if (!a) problems.push(`seq ${r.seq}: missing`);
    else if (a.type !== r.type || a.hash !== r.hash) {
      problems.push(`seq ${r.seq}: was ${r.type} ${r.hash}, now ${a.type} ${a.hash}`);
    } else kept++;
  }
  const last = before.reduce((n, r) => Math.max(n, r.seq), 0);
  return {
    intact: problems.length === 0,
    kept,
    added: after.filter((r) => r.seq > last).length,
    problems,
  };
}

/** What `sekhemet log` said about the chain and the projections. */
export function readLogVerdict(out) {
  return {
    chainValid: /SHA-256 Chain Verification: VALID/.test(out.stdout),
    projectionsIdentical: /Projections: rebuilt from \d+ events, byte-identical/.test(out.stdout),
    anchor: /Ledger-Head anchor at seq \d+ matches/.test(out.stdout)
      ? "matches"
      : /TRUNCATED|REWRITTEN/.test(out.stdout)
        ? "broken"
        : "none",
    exit: out.code,
  };
}

/**
 * One crash: a writer (`ledger_writer.mjs`, this build's kernel through the
 * CLI's own `openLocalLedger`) creates and moves issues without pause; once
 * it has written `killAfterEvents` events it gets SIGKILL, mid-write. Then
 * this build's `sekhemet log` reopens the ledger and checks the chain and
 * the projections, a CLI write lands, and the check runs again.
 */
export async function crashTrial({ repo, killAfterEvents = 60, env: given } = {}) {
  if (!existsSync(join(repo, ".git"))) makeRepo(repo);
  const own = given ? undefined : mkdtempSync(join(tmpdir(), "milestone-env-"));
  const env = given ?? isolatedEnv(own);
  try {
    return await killAndCheck(repo, env, killAfterEvents);
  } finally {
    if (own) rmSync(own, { recursive: true, force: true });
  }
}

async function killAndCheck(repo, env, killAfterEvents) {
  const db = join(repo, ".sekhemet", "events.db");
  const writer = spawn(process.execPath, [join(import.meta.dirname, "ledger_writer.mjs"), repo], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let written = 0;
  let walAtKill = false;
  let stderr = "";
  writer.stderr.on("data", (d) => {
    stderr += d;
  });
  const killed = new Promise((resolve) => {
    writer.on("exit", (code, signal) => resolve({ code, signal }));
  });
  writer.stdout.on("data", (d) => {
    for (const line of String(d).split("\n")) {
      const seq = Number(line.trim());
      if (Number.isFinite(seq) && seq > written) written = seq;
    }
    if (written >= killAfterEvents && writer.exitCode === null && !writer.killed) {
      const wal = `${db}-wal`;
      walAtKill = existsSync(wal) && statSync(wal).size > 0;
      writer.kill("SIGKILL");
    }
  });
  const exit = await killed;
  if (exit.signal !== "SIGKILL") {
    throw new Error(`the writer ended before it was killed (${exit.code}): ${stderr.trim()}`);
  }
  const eventsAtRestart = chainRows(db).length;
  const first = readLogVerdict(runCli(["log", "--repo", repo], { env }));
  // The ledger takes writes again: a person parks an issue from the terminal.
  const park = runCli(["park", "card_crash_1", "after the crash", "--repo", repo], { env });
  const second = readLogVerdict(runCli(["log", "--repo", repo], { env }));
  const eventsAfter = chainRows(db).length;
  return {
    killedBy: exit.signal,
    writtenBeforeKill: written,
    walAtKill,
    eventsAtRestart,
    chainValid: first.chainValid && first.exit === 0,
    projectionsIdentical: first.projectionsIdentical,
    appendedAfter:
      park.code === 0 && eventsAfter > eventsAtRestart && second.chainValid && second.exit === 0,
    eventsAfter,
  };
}
