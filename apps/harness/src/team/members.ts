import type { DatabaseSync } from "node:sqlite";
import { type Level, isLevel } from "./settings.js";

/**
 * Who belongs to the workspace, read from the event log (teams §3, the
 * `member/*` events). Nothing here is a second store: every read folds the
 * ledger, so two processes over one database agree.
 */
export interface MemberState {
  principal: string;
  /** The workspace level (a per-project override is the access module's). */
  level: Level;
  pending: boolean;
  removed: boolean;
  via: string;
  joinedSeq: number;
}

interface Row {
  seq: number;
  type: string;
  payload: string;
}

const MEMBER_TYPES =
  "('member/joined', 'member/approved', 'member/level_changed', 'member/removed')";

function fold(rows: Row[]): Map<string, MemberState> {
  const out = new Map<string, MemberState>();
  for (const row of rows) {
    const p = JSON.parse(row.payload) as {
      principal?: string;
      level?: string;
      pending?: boolean;
      via?: string;
      project?: string;
    };
    if (!p.principal) continue;
    const current = out.get(p.principal);
    if (row.type === "member/joined") {
      out.set(p.principal, {
        principal: p.principal,
        level: isLevel(p.level) ? p.level : "viewer",
        pending: p.pending === true,
        removed: false,
        via: p.via ?? "invite",
        joinedSeq: row.seq,
      });
    } else if (!current) {
      // A change for someone who never joined names no member.
    } else if (row.type === "member/approved") {
      current.pending = false;
      if (isLevel(p.level)) current.level = p.level;
    } else if (row.type === "member/level_changed") {
      if (!p.project && isLevel(p.level)) current.level = p.level;
    } else if (row.type === "member/removed") {
      current.removed = true;
    }
  }
  return out;
}

export function memberOf(db: DatabaseSync, principal: string): MemberState | undefined {
  const rows = db
    .prepare(
      `SELECT seq, type, payload FROM events
        WHERE type IN ${MEMBER_TYPES} AND json_extract(payload, '$.principal') = ?
        ORDER BY seq`,
    )
    .all(principal) as unknown as Row[];
  return fold(rows).get(principal);
}

export function allMembers(db: DatabaseSync): MemberState[] {
  const rows = db
    .prepare(`SELECT seq, type, payload FROM events WHERE type IN ${MEMBER_TYPES} ORDER BY seq`)
    .all() as unknown as Row[];
  return [...fold(rows).values()];
}

export function hasAdmin(db: DatabaseSync): boolean {
  return allMembers(db).some((m) => m.level === "admin" && !m.pending && !m.removed);
}

/** The principal whose recorded email is `email` (private, erasable), first recorded first. */
export function personByEmail(db: DatabaseSync, email: string): string | undefined {
  const row = db
    .prepare(
      `SELECT COALESCE(e.principal, json_extract(e.payload, '$.principal')) AS principal
         FROM events e JOIN event_private p ON p.event_id = e.id
        WHERE e.type = 'person/created'
          AND lower(json_extract(p.body, '$.email')) = lower(?)
        ORDER BY e.seq LIMIT 1`,
    )
    .get(email.trim()) as { principal: string | null } | undefined;
  return row?.principal ?? undefined;
}

/** A person's recorded name, for "invited by" (private, erasable). */
export function personName(db: DatabaseSync, principal: string): string | undefined {
  const row = db
    .prepare(
      `SELECT json_extract(p.body, '$.name') AS name
         FROM events e JOIN event_private p ON p.event_id = e.id
        WHERE e.type = 'person/created'
          AND COALESCE(e.principal, json_extract(e.payload, '$.principal')) = ?
          AND json_extract(p.body, '$.name') IS NOT NULL
        ORDER BY e.seq DESC LIMIT 1`,
    )
    .get(principal) as { name: string | null } | undefined;
  return row?.name ?? undefined;
}

/** A person's recorded email, for the Members list (Admins only). */
export function personEmail(db: DatabaseSync, principal: string): string | undefined {
  const row = db
    .prepare(
      `SELECT json_extract(p.body, '$.email') AS email
         FROM events e JOIN event_private p ON p.event_id = e.id
        WHERE e.type = 'person/created'
          AND COALESCE(e.principal, json_extract(e.payload, '$.principal')) = ?
          AND json_extract(p.body, '$.email') IS NOT NULL
        ORDER BY e.seq DESC LIMIT 1`,
    )
    .get(principal) as { email: string | null } | undefined;
  return row?.email ?? undefined;
}

/**
 * Events after `seq` that end or rotate a person's sessions (TEAM-10,
 * TEAM-36): a level change (any project), removal, a password reset issued
 * or a password changed.
 */
export function sessionEventsSince(
  db: DatabaseSync,
  principal: string,
  seq: number,
): { seq: number; type: string; level?: string }[] {
  const rows = db
    .prepare(
      `SELECT seq, type, payload FROM events
        WHERE seq > ?
          AND type IN ('member/level_changed', 'member/removed', 'password/reset_issued', 'password/changed')
          AND json_extract(payload, '$.principal') = ?
        ORDER BY seq`,
    )
    .all(seq, principal) as unknown as Row[];
  return rows.map((r) => {
    const p = JSON.parse(r.payload) as { level?: string };
    return { seq: r.seq, type: r.type, ...(p.level ? { level: p.level } : {}) };
  });
}
