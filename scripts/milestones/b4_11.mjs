/**
 * B4.11 — a team of five, at four access levels, takes a project from a
 * stakeholder's conversation to an accepted release on one server
 * (teams §6: every write in that run attributed and permitted).
 *
 * Built here, without a model: the team on one real server (B4.10's five
 * people at four levels, signed in through its routes), and the journey's
 * audit over the ledger — the stakeholder's plan sent for approval and
 * approved by a Member (`plan/sent_for_approval`, `plan/approved`), a
 * release accepted (`slice/accepted`) by a person the Accept rule allows,
 * and every event a person caused naming one of the five. The audit is run
 * on the ledger this runner produced, so its journey steps read NOT RUN:
 * the conversation needs Seshat's model, and the plan's issues need the
 * Worker, for a live run (the capstone).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { signedInTeam } from "./b4_10.mjs";
import { check } from "./core.mjs";

/** The journey's facts on a ledger (read only), and who caused each person's event. */
export function journeyAudit(dbPath, people) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const principals = new Map(Object.values(people).map((p) => [p.principal, p]));
    const rows = (type) =>
      db
        .prepare("SELECT seq, principal, payload FROM events WHERE type = ? ORDER BY seq")
        .all(type);
    const sent = rows("plan/sent_for_approval").filter(
      (e) => principals.get(e.principal)?.level === "stakeholder",
    );
    const approved = rows("plan/approved").filter((e) =>
      ["member", "admin"].includes(principals.get(e.principal)?.level ?? ""),
    );
    const accepted = rows("slice/accepted");
    const unattributed = db
      .prepare(
        "SELECT seq, type, principal FROM events WHERE actor IN ('human', 'mcp') AND (principal IS NULL OR principal NOT LIKE 'p_%')",
      )
      .all();
    const strangers = db
      .prepare(
        "SELECT DISTINCT principal FROM events WHERE actor IN ('human', 'mcp') AND principal IS NOT NULL",
      )
      .all()
      .map((r) => r.principal)
      .filter((p) => !principals.has(p));
    return { sent, approved, accepted, unattributed, strangers };
  } finally {
    db.close();
  }
}

export async function run(flags = []) {
  const base = mkdtempSync(join(tmpdir(), "milestone-b4-11-"));
  const checks = [];
  let audit;
  const { team, levels } = await signedInTeam(base);
  try {
    checks.push(
      check(
        "a team of five at four levels on one server",
        Object.entries(levels).every(([key, level]) => team.people[key].level === level),
        Object.entries(levels)
          .map(([key, level]) => `${team.people[key].name} ${level}`)
          .join(", "),
      ),
    );
    audit = journeyAudit(join(team.repo, ".sekhemet", "events.db"), team.people);
  } finally {
    await team.stop();
    if (!flags.includes("--keep")) rmSync(base, { recursive: true, force: true });
  }
  checks.push(
    check(
      "every write attributed to one of the five",
      audit.unattributed.length === 0 && audit.strangers.length === 0,
      `${audit.unattributed.length} events a person caused without a principal; ${audit.strangers.length} principals outside the team (on this runner's sign-in ledger)`,
    ),
  );
  checks.push(
    check(
      "a stakeholder's conversation with Seshat becomes a plan a Member approves",
      audit.sent.length > 0 && audit.approved.length > 0 ? true : null,
      "needs Seshat's model loaded on the reference machine (the capstone run)",
    ),
  );
  checks.push(
    check(
      "the plan's issues built, reviewed and accepted under the Accept rule, and the release accepted",
      audit.accepted.length > 0 ? true : null,
      "needs the Worker model for a live run (the capstone), then this audit on its ledger",
    ),
  );
  return { checks, details: { people: levels } };
}
