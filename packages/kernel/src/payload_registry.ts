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
const NOTICE_KIND = v.picklist([
  "review",
  "parked",
  "budget",
  "question",
  "decision",
  "standup",
  "needs_you",
  "run_report",
  "slow_load",
  "requantised",
  "test",
]);
const DAY = v.pipe(v.string(), v.regex(/^\d{4}-\d{2}-\d{2}$/, "a local day, YYYY-MM-DD"));
/** The access levels of the Team setup (teams item 6). */
const LEVEL = v.picklist(["admin", "member", "stakeholder", "viewer"]);

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

/** A model role (models `MODEL_ROLES`, validated by its writer; the kernel does not enumerate them). */
const ASSIGNED_ROLE = ID;
const ASSIGNMENT_SCOPE = v.picklist(["personal", "baseline", "default"]);

// models NEW-models-14 (Smart Swap): swap records carry the weights' key, never their path.
const VOLUME = v.picklist(["internal", "external"]);
const CACHE_STATE = v.picklist(["cold", "warm"]);
const MS = v.pipe(v.number(), v.minValue(0));
const BYTES = v.pipe(v.number(), v.integer(), v.minValue(0));
const QUEUES = v.array(ID);
const SWAP_BASE = { model: s(ID), roles: s(QUEUES) };
const ENGINE = v.picklist(["llama.cpp", "ollama", "mlx"]);
const LOAD_MODE = v.picklist(["mmap", "no_mmap", "preread_mmap"]);

export const PAYLOAD_SCHEMAS: Readonly<Record<string, PayloadSchema>> = {
  // models MD-N14-1: a load the residency scheduler ordered, timed, with its prediction.
  "model/loaded": {
    ...SWAP_BASE,
    volume: s(VOLUME),
    bytes: s(BYTES),
    cache: s(CACHE_STATE),
    loadMs: s(MS),
    medianMs: s(MS),
    p90Ms: s(MS),
    basis: s(v.picklist(["measured", "estimate"])),
    // models rule 20h: the engine and load mode (MD-N14-34).
    engine: s(ENGINE, true),
    loadMode: s(LOAD_MODE, true),
  },
  // models MD-N14-34, MD-N14-40a: a load-mode A/B's result per mode and its choice.
  "model/load_mode_ab": {
    model: s(ID),
    volume: s(VOLUME),
    engine: s(ENGINE),
    modes: s(
      v.array(
        v.strictObject({
          mode: LOAD_MODE,
          loads: BYTES,
          medianLoadMs: MS,
          medianFirstTokenMs: MS,
          medianTotalMs: MS,
        }),
      ),
    ),
    decided: s(v.boolean()),
    chosen: s(LOAD_MODE),
  },
  // models MD-N14-33, MD-N14-40a: a GPU ceiling recorded (a Metal timeout, a calibration night).
  "model/gpu_ceiling": {
    basis: s(v.picklist(["metal_timeout", "calibrated"])),
    bytes: s(BYTES),
    models: s(v.array(ID), true),
  },
  // models rule 20h: a model Ollama serves with another quantisation or hash than its file.
  "model/requantised": {
    model: s(ID),
    servedQuant: s(ID, true),
    fileQuant: s(ID, true),
    hashDiffers: s(v.boolean()),
  },
  // models MD-N14-12, MD-N14-40a: θ over the rolling hour, with the policy's parameters.
  "model/swap_overhead": {
    theta: s(v.pipe(v.number(), v.minValue(0))),
    windowMs: s(MS),
    swapMs: s(MS),
    swaps: s(BYTES),
    placementNotice: s(v.boolean()),
    policyVersion: s(ID),
    params: s(v.record(v.string(), v.number())),
  },
  // measurement MS-NM14-3, models MD-N14-40a: a calibration night's declared protocol.
  "measure/calibration": {
    policyVersion: s(ID),
    params: s(v.record(v.string(), v.number())),
    models: s(v.array(ID)),
    volumes: s(v.array(VOLUME)),
    loadModes: s(v.array(LOAD_MODE)),
    abOrder: s(v.array(LOAD_MODE)),
    probes: s(v.array(v.picklist(["read_probe", "drive_check", "headroom"]))),
    equivalenceCheck: s(v.boolean()),
  },
  // models MD-N14-2: an unload, timed, and whether it was proven.
  "model/unloaded": {
    ...SWAP_BASE,
    volume: s(VOLUME),
    bytes: s(BYTES),
    unloadMs: s(MS),
    confirmed: s(v.boolean()),
  },
  // models MD-N14-2: the first reply after a recorded load.
  "model/first_token": { ...SWAP_BASE, firstTokenMs: s(MS) },
  // models MD-N14-5: a load past its bound, with its likely causes and fixes.
  "model/slow_load": {
    ...SWAP_BASE,
    volume: s(VOLUME),
    bytes: s(BYTES),
    cache: s(CACHE_STATE),
    loadMs: s(MS),
    boundMs: s(MS),
    causes: s(
      v.array(v.picklist(["external_volume", "memory_pressure", "swap_in_use", "cold_cache"])),
    ),
    fixes: s(v.array(v.picklist(["copy_to_internal", "free_memory", "prewarm_overnight"]))),
  },
  // models NEW-models-10: a role's model, assigned or restored by a person.
  "models/assigned": {
    role: s(ASSIGNED_ROLE),
    model: s(ID),
    scope: s(ASSIGNMENT_SCOPE),
    qualification: s(v.picklist(["qualified", "overridden", "failed", "invalidated", "missing"])),
    previous: s(ID, true),
    bakeOff: s(ID, true),
  },
  // context CX-N3-7: the fit of Seshat's prompt; numbers and section ids only.
  "pm/prompt_fitted": {
    reply: s(ID),
    role: s(ID),
    windowTokens: s(v.number()),
    budgetTokens: s(v.number()),
    usedTokens: s(v.number()),
    sections: s(v.array(v.strictObject({ id: ID, tokens: v.number() }))),
  },
  "models/restored": {
    role: s(ASSIGNED_ROLE),
    model: s(ID),
    scope: s(ASSIGNMENT_SCOPE),
    replaced: s(ID, true),
  },
  "person/created": {
    principal: s(PRINCIPAL),
    local: s(v.boolean(), true),
    email: priv("personal", TEXT),
    name: priv("personal", TEXT),
  },
  // teams §3 (B4.10, NEW-teams-1, -3, -4): members, sign-in and credentials.
  // Principals and opaque references only; an invitee's email, a token's
  // name and a refused address are private. No credential or hash, ever (TEAM-11).
  "member/invited": {
    invite: s(ID),
    level: s(LEVEL),
    expires: s(TEXT),
    project: s(ID, true),
    email: priv("personal", TEXT),
  },
  "member/joined": {
    principal: s(PRINCIPAL),
    level: s(LEVEL),
    via: s(v.picklist(["setup", "invite", "signup", "proxy", "oidc"])),
    pending: s(v.boolean()),
    invite: s(ID, true),
    project: s(ID, true),
  },
  "member/approved": { principal: s(PRINCIPAL), level: s(LEVEL, true) },
  "member/level_changed": { principal: s(PRINCIPAL), level: s(LEVEL), project: s(ID, true) },
  "member/removed": { principal: s(PRINCIPAL) },
  "session/started": {
    session: s(ID),
    method: s(v.picklist(["password", "passkey", "oidc", "setup", "invite"])),
  },
  // Presence (models rule 20e, C6): a person's dashboard request, at most once per 5 minutes each.
  "session/active": { via: s(v.picklist(["solo", "session", "proxy"])) },
  "session/ended": {
    session: s(ID),
    reason: s(
      v.picklist([
        "signed_out",
        "idle",
        "expired",
        "removed",
        "level_lowered",
        "password_reset",
        "password_changed",
        "revoked",
      ]),
    ),
  },
  "session/refused": {
    reason: s(
      v.picklist([
        "bad_credentials",
        "unknown_account",
        "bad_setup_token",
        "bad_invite",
        "bad_reset_link",
      ]),
    ),
    count: s(v.pipe(v.number(), v.integer(), v.minValue(1))),
    window: s(TEXT),
    address: priv("personal", TEXT),
  },
  "account/locked": { principal: s(PRINCIPAL), until: s(TEXT, true) },
  "account/unlocked": { principal: s(PRINCIPAL) },
  "token/created": {
    token: s(ID),
    level: s(LEVEL),
    expires: s(TEXT),
    name: priv("free_text", TEXT),
  },
  "token/used": { token: s(ID) },
  "token/revoked": { token: s(ID), reason: s(v.picklist(["member_removed"]), true) },
  "password/reset_issued": { principal: s(PRINCIPAL), expires: s(TEXT) },
  "password/changed": {
    principal: s(PRINCIPAL),
    via: s(v.picklist(["setup", "invite", "reset"])),
  },
  "passkey/registered": { principal: s(PRINCIPAL), passkey: s(ID) },
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
  // integrations M3 (B4.9 part 2): a card an import created or changed; its
  // text reaches the Worker tagged untrusted, whatever its external link.
  "card/imported": { id: s(ID), proposal: s(ID, true) },
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
    // INT-20c: `{field: "state", reason: "done_before_accept", at}` — the
    // tracker closed a linked card the board had not accepted; when it closed.
    field: s(v.picklist(["title", "body", "labels", "assignee", "state"]), true),
    reason: s(v.picklist(["unmapped", "done_before_accept"]), true),
    at: s(TEXT, true),
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
      v.picklist([
        "create_card",
        "external_review",
        "verify_dependency_pr",
        "pull_request_closed",
        "issue_closed",
      ]),
    ),
  },
  // integrations INT-11b: a pull that caught up after a restart or a gap in
  // the App's delivery log, with how many deliveries the gap held and what it took.
  "github/catch_up": {
    reason: s(v.picklist(["restart", "gap"])),
    gaps: s(v.pipe(v.number(), v.integer(), v.minValue(0))),
    created: s(v.pipe(v.number(), v.integer(), v.minValue(0))),
    updated: s(v.pipe(v.number(), v.integer(), v.minValue(0))),
    errors: s(v.pipe(v.number(), v.integer(), v.minValue(0))),
  },
  // integrations INT-20b: a linked card's state shown as its issue's
  // Projects status; which projects by id, never a login.
  "github/agent_status": {
    id: s(ID),
    ref: s(ID),
    status: s(v.picklist(["queued", "working", "waiting_for_review", "completed"])),
    projects: s(v.array(ID)),
    skipped: s(TEXT, true),
  },
  // integrations INT-16a, INT-16: a dependency bot's pull request verified by
  // the full gates on its head, and what the project's policy did with it.
  "github/dependency_verified": {
    id: s(ID),
    pr: s(v.pipe(v.number(), v.integer(), v.minValue(1))),
    headSha: s(v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/))),
    passed: s(v.boolean()),
    autoMerge: s(
      v.picklist([
        "enabled",
        "not_allowed",
        "gates_failed",
        "head_moved",
        "not_dependency_bot",
        "refused",
      ]),
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
    gateStatus: s(v.picklist(["pass", "fail", "partial", "unavailable"]), true),
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
  // gates rule 6a (lead ruling, B4.0b review): a test file staged for a card —
  // its path, its SHA-256 and who wrote it. A Planner, test-author or PM
  // carry-over record makes the file the card's own; structural only.
  "test/staged": {
    cardId: s(ID),
    path: s(ID),
    sha256: s(SHA256),
    author: s(v.picklist(["planner", "test-author", "pm", "person", "repository", "suite"])),
  },
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
  // The one notifier (integrations items 20-23a): which channel, which kind,
  // whether it went, and for the budget the person, the notice and the day.
  // The notice's text and the channel's URL or token are never on the ledger.
  "pm/notify": {
    channel: s(v.picklist(["ntfy", "gotify", "slack"])),
    kind: s(NOTICE_KIND),
    ok: s(v.boolean()),
    to: s(PRINCIPAL, true),
    notice: s(ID, true),
    day: s(DAY, true),
  },
  "pm/notice_held": {
    kind: s(NOTICE_KIND),
    to: s(PRINCIPAL, true),
    notice: s(ID),
    day: s(DAY, true),
  },
  // A notifier's claim on a send, recorded under an id derived from the
  // notice — or the channel's standup and its attempt — before it is sent,
  // so of two notifiers on one ledger only one sends it (B4.9 part 2, B2).
  "pm/notify_claimed": {
    kind: s(NOTICE_KIND),
    notice: s(ID),
    to: s(PRINCIPAL, true),
    day: s(DAY, true),
    channel: s(v.picklist(["ntfy", "gotify", "slack"]), true),
    attempt: s(v.pipe(v.number(), v.integer(), v.minValue(0)), true),
  },
  // teams M6: a recorded switch of setup; Solo starts on a Team ledger only after one.
  "setup/switched": { to: s(v.picklist(["solo", "team"])) },
  // teams NEW-teams-2 (TEAM-7): a profile label, which grants nothing.
  "member/label_changed": { principal: s(PRINCIPAL), label: s(TEXT) },
  // teams TEAM-32: only the fields that changed.
  "project/settings_changed": {
    project: s(ID),
    accept_rule: s(v.array(PRINCIPAL), true),
    require_resolved_threads: s(v.boolean(), true),
    lead: s(PRINCIPAL, true),
    auto_apply: s(
      v.record(v.picklist(["label", "priority", "duplicate", "split"]), v.boolean()),
      true,
    ),
  },
  // teams TEAM-4, integrations INT-22: a refused request, by the person's principal.
  "access/refused": {
    permission: s(ID),
    level: s(v.picklist(["viewer", "stakeholder", "member", "admin", "none"])),
    needs: s(LEVEL),
    project: s(ID, true),
  },
  // teams TEAM-30: an Agent issue queued because its person is at the cap.
  "queue/capped": {
    id: s(ID),
    cap: s(v.pipe(v.number(), v.integer(), v.minValue(1))),
    running: s(v.pipe(v.number(), v.integer(), v.minValue(0))),
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
