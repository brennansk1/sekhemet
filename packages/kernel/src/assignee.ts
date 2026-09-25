import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AppendEventParams, CardDelegate } from "./types.js";

/**
 * The legacy `assignee` string mapped to who is on a card (kernel rule 21,
 * NEW-kernel-6, K-N6-6): `worker` is the Worker as delegate; `human` is the
 * project's single principal as owner; any other value is a person's name
 * (or email), that person's principal as owner — a person with that name is
 * created, the name in the private part, when none exists yet.
 */
export type AssigneeTarget = { delegate: CardDelegate } | { owner: string };

/** How the mapping records a new person: an append in or out of a transaction. */
export type PersonAppend = (params: AppendEventParams<Record<string, unknown>>) => void;

function newPrincipal(): string {
  return `p_${randomBytes(12).toString("hex")}`;
}

function personByName(db: DatabaseSync, name: string): string | undefined {
  const row = db
    .prepare(
      `SELECT COALESCE(e.principal, json_extract(e.payload, '$.principal')) AS principal
         FROM events e JOIN event_private p ON p.event_id = e.id
        WHERE e.type = 'person/created'
          AND (lower(json_extract(p.body, '$.name')) = lower(?)
            OR lower(json_extract(p.body, '$.email')) = lower(?))
        ORDER BY e.seq LIMIT 1`,
    )
    .get(name, name) as { principal: string | null } | undefined;
  return row?.principal ?? undefined;
}

/** The install's recorded local person — never another principal on the ledger (rule 19). */
function localPerson(db: DatabaseSync): string | undefined {
  const row = db
    .prepare(
      "SELECT principal FROM events WHERE type = 'person/created' AND principal IS NOT NULL AND json_extract(payload, '$.local') = 1 ORDER BY seq DESC LIMIT 1",
    )
    .get() as { principal: string } | undefined;
  return row?.principal;
}

export function assigneeTarget(
  db: DatabaseSync,
  assignee: string,
  append: PersonAppend,
  /** The install's person's details, private on a local person created here. */
  localDetails?: { email?: string; name?: string },
): AssigneeTarget | undefined {
  const value = assignee.trim();
  if (!value) return undefined;
  const lower = value.toLowerCase();
  if (lower === "worker") return { delegate: { kind: "worker" } };
  if (lower === "human") {
    const existing = localPerson(db);
    if (existing) return { owner: existing };
    // No local person yet: `human` is the install's own, created here — never
    // a named person adopted from the ledger.
    const principal = newPrincipal();
    const personal = Object.fromEntries(
      Object.entries(localDetails ?? {}).filter(([, v]) => typeof v === "string" && v.trim()),
    );
    append({
      actor: "system",
      type: "person/created",
      payload: { principal, local: true },
      principal,
      ...(Object.keys(personal).length > 0 ? { private: personal } : {}),
    });
    return { owner: principal };
  }
  const known = personByName(db, value);
  if (known) return { owner: known };
  const principal = newPrincipal();
  append({
    actor: "system",
    type: "person/created",
    payload: { principal },
    principal,
    private: { name: value },
  });
  return { owner: principal };
}
