import * as v from "valibot";
import { CARD_STATUSES } from "./transitions.js";

/**
 * The payload schema registry (kernel rule 33, S7: K-S7-4, K-S7-9, K-S7-10).
 *
 * One Valibot schema per event type ([DEC-29] O7), every field marked with
 * its data class. `structural` fields — ids, states, numbers, hashes,
 * enumerations — go in the hashed `payload`; `personal`, `free_text` and
 * `secret_bearing` fields go only in the event's erasable private part. A
 * write that fails its schema, or puts a non-structural field in `payload`,
 * is refused before anything is appended, naming the event type and field.
 *
 * An event type absent from the registry is not checked here (its writer
 * validates it); types are added as their writers route free text to the
 * private part.
 */
export const DATA_CLASSES = ["structural", "personal", "free_text", "secret_bearing"] as const;
export type DataClass = (typeof DATA_CLASSES)[number];

export interface PayloadField {
  dataClass: DataClass;
  schema: v.GenericSchema;
  /** The field may be absent. */
  optional?: boolean;
}

/** One event type's fields, payload and private part together. */
export type PayloadSchema = Readonly<Record<string, PayloadField>>;

const PRINCIPAL = v.pipe(v.string(), v.regex(/^p_[0-9a-z]+$/, "an opaque principal id (p_…)"));
const ID = v.pipe(v.string(), v.minLength(1));
const STATUS = v.picklist(CARD_STATUSES as readonly string[] as string[]);
const DELEGATE = v.nullable(
  v.strictObject({ kind: v.picklist(["worker", "person"]), id: v.optional(PRINCIPAL) }),
);
const TEXT = v.string();
const SHA256 = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/, "a SHA-256 hex digest"));
const SHARED_FIELD = v.picklist(["title", "body", "labels", "assignee"]);

const s = (schema: v.GenericSchema, optional = false): PayloadField => ({
  dataClass: "structural",
  schema,
  ...(optional ? { optional } : {}),
});
const priv = (dataClass: Exclude<DataClass, "structural">, schema: v.GenericSchema) => ({
  dataClass,
  schema,
  optional: true,
});

export const PAYLOAD_SCHEMAS: Readonly<Record<string, PayloadSchema>> = {
  "person/created": {
    principal: s(PRINCIPAL),
    local: s(v.boolean(), true),
    email: priv("personal", TEXT),
    name: priv("personal", TEXT),
  },
  "card/override": {
    id: s(ID),
    from: s(STATUS),
    to: s(STATUS),
    overrode: s(TEXT),
    principal: s(PRINCIPAL, true),
    reason: priv("free_text", TEXT),
  },
  "playbook/candidate": {
    cardId: s(ID),
    reason: priv("free_text", TEXT),
  },
  "card/delegated": { id: s(ID), from: s(DELEGATE), to: s(DELEGATE) },
  "card/owner_changed": {
    id: s(ID),
    from: s(v.nullable(PRINCIPAL)),
    to: s(v.nullable(PRINCIPAL)),
  },
  "card/pr_opened": {
    id: s(ID),
    pr: s(v.pipe(v.number(), v.integer(), v.minValue(1))),
    url: s(TEXT),
    headSha: s(TEXT),
    accepter: s(PRINCIPAL, true),
  },
  // integrations INT-12: the tracker's pull request as opened, for the
  // lifecycle and the webhook's repository match; no login (B4.9 re-check).
  "github/pr_opened": {
    number: s(v.pipe(v.number(), v.integer(), v.minValue(1))),
    nodeId: s(TEXT),
    url: s(TEXT),
    headSha: s(TEXT),
    repo: s(v.strictObject({ owner: ID, repo: ID })),
  },
  "card/pr_closed": {
    id: s(ID),
    pr: s(v.pipe(v.number(), v.integer(), v.minValue(1))),
    merged: s(v.boolean()),
    // integrations INT-13, INT-14: the merge commit, and who closed it — the
    // principal when their login is linked, else only the login, privately.
    mergeCommit: s(v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/)), true),
    closedBy: s(PRINCIPAL, true),
    closedByHandle: priv("personal", TEXT),
  },
  // integrations item 6, NEW-integrations-2: a person's login on a tracker.
  "person/identity_linked": {
    principal: s(PRINCIPAL),
    system: s(v.picklist(["github", "forgejo"])),
    handle: priv("personal", v.pipe(v.string(), v.minLength(1))),
  },
  // integrations items 4 and 9 (B4.9 review B2): what a sync agreed — the
  // ref, the tracker's updatedAt and hashes on the chain; the item and the
  // agreed fields (logins, the issue's text) private and erasable.
  "sync/snapshot": {
    ref: s(v.strictObject({ system: v.picklist(["github", "forgejo"]), id: ID, url: v.string() })),
    updatedAt: s(TEXT),
    itemHash: s(SHA256),
    agreedHash: s(SHA256),
    boardOwner: s(v.nullable(PRINCIPAL)),
    worker: s(v.boolean()),
    item: priv("personal", v.record(v.string(), v.unknown())),
    agreed: priv("personal", v.record(v.string(), v.unknown())),
  },
  // integrations INT-6 and INT-41: which field, who won and when on the
  // chain; the values, or the unmapped login, private.
  "sync/conflict": {
    fields: s(
      v.array(
        v.strictObject({
          field: SHARED_FIELD,
          winner: v.picklist(["board", "tracker"]),
          at: v.string(),
        }),
      ),
      true,
    ),
    field: s(SHARED_FIELD, true),
    reason: s(v.literal("unmapped"), true),
    values: priv("personal", v.array(v.record(v.string(), v.unknown()))),
    assignee: priv("personal", v.pipe(v.string(), v.minLength(1))),
  },
  // integrations INT-11a: a running card's scope or criteria changed in the tracker.
  "sync/scope_changed": {
    id: s(ID),
    fields: s(v.array(SHARED_FIELD)),
    change: s(v.picklist(["scope", "criteria"])),
  },
  // integrations INT-11e: a card nested deeper than the tracker, linked to its written ancestor.
  "sync/clamped": {
    id: s(ID),
    ancestor: s(ID),
    ref: s(ID),
    maxDepth: s(v.pipe(v.number(), v.integer(), v.minValue(1))),
  },
  // integrations INT-9: a webhook delivery processed, by its id and intent kind.
  "github/delivery": {
    delivery: s(ID),
    intent: s(
      v.picklist(["create_card", "external_review", "verify_dependency_pr", "pull_request_closed"]),
    ),
  },
  // security item 33: each request the network policy decided, allowed or refused.
  // The URL is private: its path and query can carry what a person asked
  // (B4.9 lead review). Events written before B4.9 carry it in the payload.
  "harness/egress": {
    url: priv("free_text", TEXT),
    urlHash: s(SHA256),
    host: s(TEXT),
    purpose: s(ID),
    allowed: s(v.boolean()),
    reason: s(TEXT, true),
    status: s(v.pipe(v.number(), v.integer()), true),
    payloadHash: s(v.pipe(v.string(), v.regex(/^([0-9a-f]{64})?$/))),
    at: s(TEXT),
  },
  // review-git §3: Accept, its undo, and the review records (S5, S6, NEW-review-git-5).
  "card/accepted": {
    id: s(ID),
    sha: s(v.pipe(v.string(), v.regex(/^[0-9a-f]{7,40}$/)), true),
    pr: s(TEXT, true),
    // Accept always writes both (RG-S5-7, RG-N5-1); ledgers from before B3.2 lack them.
    principal: s(PRINCIPAL, true),
    independent: s(v.boolean(), true),
    auto: s(v.literal(true), true),
    gateStatus: s(v.picklist(["pass", "fail", "partial"]), true),
    integration: s(ID, true),
  },
  // worker-loop NEW-worker-loop-10: collaborating on a running issue (DEC-34).
  "card/message": { id: s(ID), principal: s(PRINCIPAL), message: priv("free_text", TEXT) },
  "card/pause_requested": { id: s(ID), principal: s(PRINCIPAL) },
  "card/handed_back": { id: s(ID), principal: s(PRINCIPAL), note: priv("free_text", TEXT) },
  "card/message_delivered": {
    id: s(ID),
    message: s(ID),
    step: s(v.pipe(v.number(), v.integer(), v.minValue(1))),
  },
  "card/taken_over": { id: s(ID), principal: s(PRINCIPAL) },
  // security item 39 (S9): a person trusted the repository's configuration
  // as it is now — who, and each file by its repository-relative path and SHA-256.
  "workspace/trusted": {
    principal: s(PRINCIPAL),
    files: s(
      v.array(
        v.strictObject({
          path: ID,
          sha256: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
        }),
      ),
    ),
  },
  "card/reverted": {
    id: s(ID),
    sha: s(v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/))),
    revertSha: s(v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/))),
    principal: s(PRINCIPAL),
    reason: priv("free_text", TEXT),
  },
  "review/auto_accept_enabled": { principal: s(PRINCIPAL), run: s(ID) },
  "review/opened": {
    id: s(ID),
    principal: s(PRINCIPAL),
    evidence: s(ID, true),
    filesShown: s(v.array(TEXT)),
  },
  "review/decided": {
    id: s(ID),
    principal: s(PRINCIPAL),
    decision: s(v.picklist(["accept", "send_back", "park", "reject"])),
    linesReviewed: s(v.pipe(v.number(), v.integer(), v.minValue(0))),
    minutes: s(v.pipe(v.number(), v.minValue(0))),
    acknowledgedFindings: s(v.array(TEXT)),
    project: s(ID, true),
  },
  // NEW-kernel-8: requirement versions and suspect links.
  "requirement/created": {
    id: s(ID),
    version: s(v.pipe(v.number(), v.integer(), v.minValue(1))),
    title: priv("free_text", TEXT),
  },
  "requirement/revised": {
    id: s(ID),
    version: s(v.pipe(v.number(), v.integer(), v.minValue(2))),
    title: priv("free_text", TEXT),
  },
  "trace/linked": {
    requirementId: s(ID),
    version: s(v.pipe(v.number(), v.integer(), v.minValue(1))),
    from: s(v.picklist(["card", "test"])),
    ref: s(ID),
  },
  "trace/confirmed": {
    requirementId: s(ID),
    version: s(v.pipe(v.number(), v.integer(), v.minValue(1))),
    from: s(v.picklist(["card", "test"])),
    ref: s(ID),
  },
};

function objectOf(fields: [string, PayloadField][]): v.GenericSchema {
  return v.strictObject(
    Object.fromEntries(fields.map(([k, f]) => [k, f.optional ? v.optional(f.schema) : f.schema])),
  );
}

function refuse(type: string, part: string, issues: v.BaseIssue<unknown>[]): never {
  const issue = issues[0];
  const field = (issue && v.getDotPath(issue)) ?? issue?.path?.[0]?.key ?? "(payload)";
  throw new Error(
    `A ${type} event's ${part} fails its schema at field ${String(field)}: ${issue?.message ?? "invalid"} (kernel rule 33, K-S7-4)`,
  );
}

/**
 * Check one event against its registered schema (K-S7-4, K-S7-9). Throws,
 * naming the type and the field; returns nothing when the type is unregistered.
 */
export function checkEventPayload(
  type: string,
  payload: unknown,
  privatePart: Record<string, unknown> | undefined,
): void {
  const schema = PAYLOAD_SCHEMAS[type];
  if (!schema) return;
  const entries = Object.entries(schema);
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    for (const key of Object.keys(payload)) {
      const field = schema[key];
      if (field && field.dataClass !== "structural") {
        throw new Error(
          `A ${type} event's field ${key} is ${field.dataClass}: it goes in the event's private part, never in the payload (kernel rule 33, K-S7-9)`,
        );
      }
    }
  }
  const structural = entries.filter(([, f]) => f.dataClass === "structural");
  const payloadResult = v.safeParse(objectOf(structural), payload);
  if (!payloadResult.success) refuse(type, "payload", payloadResult.issues);
  if (privatePart !== undefined) {
    const nonStructural = entries.filter(([, f]) => f.dataClass !== "structural");
    const privateResult = v.safeParse(objectOf(nonStructural), privatePart);
    if (!privateResult.success) refuse(type, "private part", privateResult.issues);
  }
}
