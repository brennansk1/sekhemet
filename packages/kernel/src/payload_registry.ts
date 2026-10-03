import * as v from "valibot";
import { DEPTH_PROFILES } from "./depth_profile.js";
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
  // planner-pm PM-N9-6: "Update due", "N issues waiting for review".
  "reminder",
  // teams TEAM-43 (item 22): a watched issue's change, a mention, a posted
  // project update, and the daily digest of what is still unread.
  "watching",
  "mentioned",
  "project_update",
  "digest",
  "test",
]);
const DAY = v.pipe(v.string(), v.regex(/^\d{4}-\d{2}-\d{2}$/, "a local day, YYYY-MM-DD"));
/** Review plan's choices for a new project (PM_CONTRACT §3; design-stage DS-P2-7). */
const PLAN_CHOICES = v.strictObject({
  accept: v.optional(v.array(ID)),
  remove: v.optional(v.array(ID)),
  releaseLine: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  type: v.optional(v.picklist(DEPTH_PROFILES as readonly string[] as string[])),
  answers: v.optional(
    v.record(v.pipe(v.string(), v.regex(/^\d+$/)), v.pipe(v.number(), v.integer(), v.minValue(0))),
  ),
});
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
/** A user config key as a dotted name (`sessions.idle_minutes`), never a value (TEAM-44). */
const CONFIG_KEY = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/));
const CONFIG_STATE = v.record(CONFIG_KEY, v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{16,64}$/)));
const ASSIGNMENT_SCOPE = v.picklist(["personal", "baseline", "default"]);

/** A mutation measure (gates `MutationMeasure`), as the nightly run records it. */
const COUNT = v.pipe(v.number(), v.integer(), v.minValue(0));
const SCORE = v.nullable(v.pipe(v.number(), v.minValue(0), v.maxValue(1)));
const MUTATION_MEASURE = v.strictObject({
  score: SCORE,
  killed: COUNT,
  total: COUNT,
  refused: v.optional(TEXT),
  notMeasured: v.array(v.strictObject({ file: ID, reason: TEXT })),
  acceptance: v.optional(
    v.strictObject({ score: SCORE, killed: COUNT, total: COUNT, reason: v.optional(TEXT) }),
  ),
  stillborn: v.optional(COUNT),
  stillbornNotJudged: v.optional(TEXT),
  equivalent: v.optional(COUNT),
  partial: v.optional(v.strictObject({ scored: COUNT, deferred: COUNT, queue: ID })),
  tools: v.optional(
    v.array(v.strictObject({ tool: ID, files: v.array(ID), refused: v.optional(TEXT) })),
  ),
  strengthUnmet: v.optional(v.boolean()),
  stale: v.optional(v.array(ID)),
});

// models NEW-models-14 (Smart Swap): swap records carry the weights' key, never their path.
const VOLUME = v.picklist(["internal", "external"]);
const CACHE_STATE = v.picklist(["cold", "warm"]);
const MS = v.pipe(v.number(), v.minValue(0));
/** A probability, such as a paired test's p. */
const PROBABILITY = v.pipe(v.number(), v.minValue(0), v.maxValue(1));
/** A research pipeline (harness `ResearchPipeline`, DS-N2-9). */
const RESEARCH_PIPELINE = v.picklist(["native", "tool-loop"]);
const BYTES = v.pipe(v.number(), v.integer(), v.minValue(0));
const QUEUES = v.array(ID);
/**
 * Whose request a `model/usage` is (measurement rule 4a). The closed list is
 * the models package's (MD-N4-1, one role type); the kernel, below it in the
 * dependency order, checks only that it is a role code.
 */
const USAGE_ROLE = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_]*$/, "a role code"));
const SWAP_BASE = { model: s(ID), roles: s(QUEUES) };
const ENGINE = v.picklist(["llama.cpp", "ollama", "mlx"]);
/** A git commit: SHA-1, abbreviated or full, or a SHA-256 repository's 64 hex. */
const COMMIT = v.pipe(v.string(), v.regex(/^(?:[0-9a-f]{7,40}|[0-9a-f]{64})$/, "a git commit"));
/** A harness-defined code (a detector's kind, a reason): lower-case words joined by `_`. */
const SLUG = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_]*$/, "a lower_snake_case code"));
const LOAD_MODE = v.picklist(["mmap", "no_mmap", "preread_mmap"]);

// planner-pm P13 (B4.3): the requirement graph's shared shapes.
const CRITERION_ID = v.pipe(
  v.string(),
  v.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "a criterion id: letters, digits, '.', '_' or '-'"),
);
const REQUIREMENT_FIELDS = {
  projectId: s(ID, true),
  sliceId: s(ID, true),
  dependsOn: s(v.array(ID), true),
  kano: s(v.picklist(["must-be", "performance", "attractive"]), true),
  mustHave: s(v.boolean(), true),
  criterionIds: s(v.array(CRITERION_ID), true),
  title: priv("free_text", TEXT),
  criteria: priv("free_text", v.record(ID, TEXT)),
  // design-stage DS-P14-2, -6, DS-TO-14: where it came from, the candidate a
  // person accepted, the checklist row, the gate invariant, the take-over claim.
  source: s(v.picklist(["person", "model-proposal", "comparable", "checklist", "takeover"]), true),
  candidateId: s(ID, true),
  checklistRow: s(SLUG, true),
  invariant: s(ID, true),
  claimId: s(ID, true),
};
const DEPTH_PROFILE = v.picklist(["prototype", "internal tool", "production", "regulated"]);
const CARD_CHANGE = v.picklist(["feature", "fix", "characterize", "refactor", "upgrade"]);
/** A tracker issue: its system and id, never its title or body (integrations INT-42). */
const ISSUE = v.strictObject({
  system: v.picklist(["github", "forgejo", "jira", "linear"]),
  id: ID,
});
const APPETITE = {
  appetiteCards: s(v.pipe(v.number(), v.integer(), v.minValue(1)), true),
  appetiteHours: s(v.pipe(v.number(), v.gtValue(0)), true),
};
/** Semantic Versioning 2.0.0, without a leading `v`. */
const SEMVER = v.pipe(
  v.string(),
  v.regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/, "a semantic version, 1.2.3"),
);
/** Keep a Changelog's categories (planner-pm §2.15.8). */
const CHANGELOG_CATEGORY = v.picklist([
  "Added",
  "Changed",
  "Deprecated",
  "Removed",
  "Fixed",
  "Security",
]);
/** teams TEAM-18: what a suggestion changes; never health. A planner's hold or removal (PM-N9-9). */
const SUGGESTION_KIND = v.picklist([
  "assignee",
  "label",
  "priority",
  "duplicate",
  "split",
  "hold",
  "remove",
]);

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
    // live-test F13: the cache state the modes were compared in.
    cache: s(v.picklist(["cold", "warm", "mixed"]), true),
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
  // models MD-N14-2: the first reply after a recorded load; its true first
  // token when it streamed, else only the reply's time (live-test F14).
  "model/first_token": { ...SWAP_BASE, firstTokenMs: s(MS, true), replyMs: s(MS, true) },
  // measurement rule 4a (fix round F2): one model request's usage outside a
  // card's step (a step's own is on `card/step`): whose request it was, what
  // it was for, the model and the counts. Never the prompt or the reply.
  "model/usage": {
    role: s(USAGE_ROLE),
    purpose: s(SLUG),
    model: s(ID),
    promptTokens: s(COUNT),
    cachedPromptTokens: s(COUNT, true),
    completionTokens: s(COUNT),
    thinkingTokens: s(COUNT),
    answerTokens: s(COUNT),
    durationMs: s(MS),
  },
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
  // A person's (or the Agent's) message to Seshat (planner-pm PM-N9-8, teams
  // §3): its text is free text — an `@Seshat` comment's body among them — so
  // it is in the erasable private part, read by the person whose it is.
  "pm/message": {
    id: s(ID),
    createdAt: s(TEXT),
    context: s(v.strictObject({ cardId: v.optional(ID), view: v.optional(TEXT) }), true),
    // planner-pm PM-N10-2: the documents the message carries — sizes, hashes
    // and repository paths here; each one's name and text in the private part.
    documents: s(
      v.array(
        v.strictObject({
          id: ID,
          chars: v.pipe(v.number(), v.integer(), v.minValue(1)),
          bytes: v.pipe(v.number(), v.integer(), v.minValue(1)),
          sha256: SHA256,
          path: v.optional(ID),
          fromMessage: v.optional(v.literal(true)),
          unfiled: v.optional(v.picklist(["no_commit", "commit_failed"])),
        }),
      ),
      true,
    ),
    text: priv("free_text", TEXT),
    // Keyed by document id: its name, and its text unless it is the message's own.
    documentTexts: priv(
      "free_text",
      v.record(ID, v.strictObject({ name: TEXT, text: v.optional(TEXT) })),
    ),
  },
  // PM-N10-3: an attached document read in parts, its notes private.
  "pm/document_read": {
    message: s(ID),
    document: s(ID),
    parts: s(v.pipe(v.number(), v.integer(), v.minValue(1))),
    windowTokens: s(v.number()),
    // Rounds of notes on the notes needed for them to fit beside the prompt.
    condensed: s(v.pipe(v.number(), v.integer(), v.minValue(1)), true),
    notes: priv("free_text", TEXT),
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
  // dashboard DB-N19-4: an Admin revoked an outstanding invite; its link stops working.
  "member/invite_revoked": { invite: s(ID) },
  "member/joined": {
    principal: s(PRINCIPAL),
    level: s(LEVEL),
    via: s(v.picklist(["setup", "invite", "signup", "proxy", "oidc"])),
    pending: s(v.boolean()),
    invite: s(ID, true),
    project: s(ID, true),
  },
  "member/approved": { principal: s(PRINCIPAL), level: s(LEVEL, true) },
  // Teams TEAM-58 (DEC-57): a one-project override may be `none`, taking the project away.
  "member/level_changed": {
    principal: s(PRINCIPAL),
    level: s(v.picklist(["admin", "member", "stakeholder", "viewer", "none"])),
    project: s(ID, true),
  },
  "member/removed": { principal: s(PRINCIPAL) },
  // Teams item 9a (NEW-teams-13, TEAM-52): what a removal settled, by id only.
  "member/removal_settled": {
    principal: s(PRINCIPAL),
    owns: s(v.array(ID), true),
    leads: s(v.array(ID), true),
    releases: s(v.array(ID), true),
    acceptSeats: s(v.array(ID), true),
    paused: s(v.array(ID), true),
    held: s(v.array(ID), true),
    emptiedRules: s(v.array(ID), true),
  },
  "member/assignment_refused": { principal: s(PRINCIPAL), cardId: s(ID) },
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
    // planner-pm PM-P1-17: each test case (its title in the file) and the
    // card criterion it proves. Titles are repository content, like a test id.
    cases: s(v.array(v.strictObject({ name: TEXT, criterionId: CRITERION_ID })), true),
  },
  // planner-pm PM-N7-5, PM-N7-4: a person approved the card's criteria as
  // they are — the SHA-256 of their canonical {id, text} list; a change voids it.
  "criteria/approved": { cardId: s(ID), sha256: s(SHA256) },
  // planner-pm PM-N7-3, PM-N7-4: a person approved a staged test file (every
  // file, regulated) or its example tables (production), at this SHA-256.
  "test/approved": {
    cardId: s(ID),
    path: s(ID),
    sha256: s(SHA256),
    what: s(v.picklist(["file", "examples"])),
  },
  // planner-pm PM-N8-2: a card waits on another, and why.
  "card/dependency_added": {
    cardId: s(ID),
    dependsOnId: s(ID),
    source: s(v.picklist(["declared", "named", "imported", "inferred", "planner"])),
    createdAt: s(TEXT),
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
  // gates rule 31 (GT-N4-1): a person made a visual candidate the baseline —
  // who, which screenshot (`<name>-<width>`) and its SHA-256, and the card
  // whose run produced it when named.
  "visual/baseline_approved": {
    principal: s(PRINCIPAL),
    key: s(v.pipe(v.string(), v.regex(/^[\w.-]+$/, "a snapshot key, <name>-<width>"))),
    sha256: s(SHA256),
    cardId: s(ID, true),
  },
  // gates rule 32 (GT-N5-5): the full mutation score of a card's deferred
  // mutants, recorded before its queue is marked complete. The reasons are
  // the harness's own fixed wording and repository paths, never a person's text.
  "card/mutation_completed": {
    queue: s(ID),
    measure: s(MUTATION_MEASURE),
  },
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
  // teams item 25 (NEW-teams-8; review-git §2 item 4): a review with no
  // verdict, GitHub's *Comment*. It opens threads — on a file's line, or on
  // the whole change — or answers one (`replyTo`). The text is private, one
  // entry per comment in order; files, lines and threads are structural.
  "review/commented": {
    id: s(ID),
    cardId: s(ID),
    threads: s(
      v.array(
        v.strictObject({
          id: ID,
          file: v.optional(TEXT),
          line: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
        }),
      ),
      true,
    ),
    replyTo: s(ID, true),
    texts: priv("free_text", v.array(TEXT)),
  },
  // TEAM-25: a review thread resolved or reopened, by the person as principal.
  "review/thread_resolved": { cardId: s(ID), thread: s(ID) },
  "review/thread_reopened": { cardId: s(ID), thread: s(ID) },
  // TEAM-24: new commits landed on an accepted issue's branch before its
  // merge; the accept is dismissed (the pull request and the new head, and
  // the accepter it no longer holds).
  "review/accept_dismissed": {
    id: s(ID),
    reason: s(v.picklist(["new_commits"])),
    pr: s(v.pipe(v.number(), v.integer(), v.minValue(1)), true),
    headSha: s(v.pipe(v.string(), v.regex(/^[0-9a-f]{7,64}$/)), true),
    accepter: s(PRINCIPAL, true),
  },
  // NEW-kernel-8: requirement versions and suspect links; planner-pm
  // PM-P13-1: its project, slice, dependencies, Kano class, must-have mark
  // and criterion ids (a revision states only what changed). The title and
  // the criteria's text are private.
  "requirement/created": {
    id: s(ID),
    version: s(v.pipe(v.number(), v.integer(), v.minValue(1))),
    ...REQUIREMENT_FIELDS,
  },
  "requirement/revised": {
    id: s(ID),
    version: s(v.pipe(v.number(), v.integer(), v.minValue(2))),
    ...REQUIREMENT_FIELDS,
  },
  // PM-P13-9: a person cut a nice-to-have from its slice; the reason is text.
  "requirement/cut": {
    id: s(ID),
    sliceId: s(ID),
    reason: priv("free_text", TEXT),
  },
  // PM-P13-9: a release slice and its appetite — cards and/or hours — set
  // before planning; the machine records reaching it; a person extends it.
  "slice/created": {
    sliceId: s(ID),
    projectId: s(ID),
    ...APPETITE,
    title: priv("free_text", TEXT),
  },
  "slice/appetite_reached": {
    sliceId: s(ID),
    projectId: s(ID),
    cards: s(COUNT),
    hours: s(MS),
  },
  "slice/extended": { sliceId: s(ID), projectId: s(ID), ...APPETITE },
  // K-N5-5: a person accepted the slice (the principal on the event).
  "slice/accepted": { projectId: s(ID), sliceId: s(ID), completesProject: s(v.boolean()) },
  // PM-P13-13: a release proposed for an accepted slice — its version and the
  // proven requirements; the changelog and the notes are text, private.
  // NEW-planner-pm-12 (PM-N12-2): a maintenance release has no slice; it
  // holds the accepted issues of the open Next release and the integration
  // branch's sha it was computed at, which a person's confirmation tags.
  "release/proposed": {
    sliceId: s(ID, true),
    projectId: s(ID),
    version: s(SEMVER),
    requirementIds: s(v.array(ID)),
    issues: s(v.array(ID), true),
    sha: s(COMMIT, true),
    changelog: priv("free_text", v.record(CHANGELOG_CATEGORY, v.array(TEXT))),
    notes: priv("free_text", TEXT),
  },
  // planner-pm PM-P13-13 (B4.3 review B): the integration branch's sha a
  // slice's release was proven at; `release --confirm` tags exactly that sha.
  "release/proven": {
    sliceId: s(ID),
    version: s(SEMVER),
    sha: s(COMMIT),
  },
  // PM-P13-13, DS-N3-8: a person tagged the release — the tag, the sha it
  // names (the documents' commit on the proven sha) and the proven sha.
  // A maintenance release's tag has no slice (PM-N12-3).
  "release/tagged": {
    sliceId: s(ID, true),
    projectId: s(ID),
    tag: s(ID),
    sha: s(COMMIT),
    proven: s(COMMIT),
  },
  // planner-pm PM-N4-3: a person marked a goal's `human` criterion met or not.
  "goal/criterion_marked": { goalId: s(ID), criterionId: s(ID), met: s(v.boolean()) },
  // teams TEAM-18, TEAM-19, planner-pm PM-N9-1: Seshat's suggestion on an
  // issue — the property and value; why is text, private. Applied (by a
  // person, or by an Admin's auto-apply rule) or dismissed by a person.
  "suggestion/proposed": {
    id: s(ID),
    cardId: s(ID),
    kind: s(SUGGESTION_KIND),
    value: s(v.union([v.string(), v.number(), v.array(v.string())])),
    why: priv("free_text", TEXT),
  },
  // TEAM-41: applied by an Admin's rule, it records the issue as it was
  // (status, labels, priority, a split's parts; the parked reason is text,
  // private) so one action undoes it; `suggestion/undone` records that act.
  "suggestion/applied": {
    id: s(ID),
    auto: s(v.boolean()),
    kind: s(SUGGESTION_KIND, true),
    before: s(
      v.strictObject({
        status: v.optional(STATUS),
        labels: v.optional(v.array(v.string())),
        priority: v.optional(v.number()),
        made: v.optional(v.array(ID)),
      }),
      true,
    ),
    blockedReason: priv("free_text", TEXT),
  },
  "suggestion/dismissed": { id: s(ID) },
  "suggestion/undone": { id: s(ID), kind: s(SUGGESTION_KIND) },
  // teams TEAM-20, design-stage §2.9 item 7: a Stakeholder's plan sent to a
  // named Member or Admin; nothing is created until they approve it. The
  // choices are Review plan's, all structural (candidate keys, the release
  // line, the Type, the questions' answer indexes).
  "plan/sent_for_approval": {
    proposalId: s(ID),
    approver: s(PRINCIPAL),
    choices: s(PLAN_CHOICES, true),
  },
  // TEAM-20, TEAM-42: the approver approved it (the event's principal); the
  // project it created, whose issues the approver owns.
  "plan/approved": { proposalId: s(ID), projectId: s(ID, true) },
  // teams item 29, planner-pm PM-N9-7: a person posted a project's update;
  // Seshat only drafts it. The text is personal free text, private.
  "project/update_posted": { project: s(ID), text: priv("free_text", TEXT) },
  // teams item 28, TEAM-28: a person set the project's health (the event's
  // principal); a model never does. One of three words.
  "project/health_set": {
    project: s(ID),
    health: s(v.picklist(["on_track", "at_risk", "off_track"])),
  },
  // dashboard DB-N9-3, DEC-37: a person set a release's target date, drawn as
  // the target line against the forecast range; no `target` clears it.
  "release/target_set": { sliceId: s(ID), projectId: s(ID), target: s(DAY, true) },
  // teams item 28, dashboard DB-N9-2: a person named a release's lead (the
  // event's principal is who named them); no `lead` clears it. A Member who
  // leads a release not yet accepted may set the project's health.
  "release/lead_set": { sliceId: s(ID), projectId: s(ID), lead: s(PRINCIPAL, true) },
  // planner-pm §2.7 item 7a (PM-N13-1, -2): a person started a sprint — the
  // issues committed to it then, and their points with estimation on — or
  // completed it: the done issues, and where each carried issue went (a
  // sprint id, or `backlog`). Each is written in one group with the sprint's
  // `cycle/updated` state (and, completing, the issues' moves).
  "cycle/started": {
    id: s(ID),
    issues: s(v.array(ID)),
    points: s(v.record(ID, v.pipe(v.number(), v.minValue(0))), true),
  },
  "cycle/completed": {
    id: s(ID),
    done: s(v.array(ID)),
    carried: s(v.array(v.strictObject({ issue: ID, to: ID }))),
  },
  // design-stage §2.9 item 7: a message in a sent plan's thread — the
  // approver's question, or the sender's answer. The words are private.
  "plan/commented": { proposalId: s(ID), id: s(ID), text: priv("free_text", TEXT) },
  // The one notifier (integrations items 20-23a): which channel, which kind,
  // whether it went, and for the budget the person, the notice and the day.
  // The notice's text and the channel's URL or token are never on the ledger.
  "pm/notify": {
    channel: s(v.picklist(["ntfy", "gotify", "slack", "email"])),
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
  // planner-pm PM-P6-10: a notice shown in Seshat's panel instead of sent,
  // the person having had the board in focus in the last five minutes.
  "pm/notice_shown": {
    kind: s(NOTICE_KIND),
    to: s(PRINCIPAL, true),
    notice: s(ID),
    day: s(DAY, true),
  },
  // PM-P6-10: the dashboard was in focus for this person.
  "pm/board_focus": { principal: s(PRINCIPAL) },
  // PM-P6-3: a standup given to this person in the chat; the next starts after it.
  "pm/standup_given": { to: s(PRINCIPAL) },
  // A notifier's claim on a send, recorded under an id derived from the
  // notice — or the channel's standup and its attempt — before it is sent,
  // so of two notifiers on one ledger only one sends it (B4.9 part 2, B2).
  "pm/notify_claimed": {
    kind: s(NOTICE_KIND),
    notice: s(ID),
    to: s(PRINCIPAL, true),
    day: s(DAY, true),
    channel: s(v.picklist(["ntfy", "gotify", "slack", "email"]), true),
    attempt: s(v.pipe(v.number(), v.integer(), v.minValue(0)), true),
  },
  // teams M6: a recorded switch of setup; Solo starts on a Team ledger only after one.
  "setup/switched": { to: s(v.picklist(["solo", "team"])) },
  // teams TEAM-44, TEAM-27: the user config.toml's keys that changed — outside
  // Sekhemet (found at start) or by a person through it — and the state as
  // keyed digests, one per key. Dotted key names and digests only: a value
  // is never recorded, and the digests' key is kept beside the credential
  // store, never in it (team/config_audit.ts), so Solo still starts.
  "config/changed_outside": { keys: s(v.array(CONFIG_KEY)), state: s(CONFIG_STATE) },
  "config/changed": { keys: s(v.array(CONFIG_KEY)), state: s(CONFIG_STATE) },
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
    // DEC-31, dashboard DB-N7-2: Preferences → Estimation, the project's.
    estimation: s(v.picklist(["off", "points"]), true),
    // review-git NEW-review-git-7 (RG-N7-5): Push to remote after Accept and on release.
    push_to_remote: s(v.boolean(), true),
  },
  // review-git NEW-review-git-7 (RG-N7-4): a push of the integration branch or
  // a tag to the project's remote, made or refused — the ref, the sha, the
  // remote's name (never its URL or a credential) and the result; why it was
  // refused is the remote's or the policy's words, private.
  "remote/pushed": {
    project: s(ID),
    ref: s(v.pipe(v.string(), v.regex(/^refs\/(?:heads|tags)\/\S+$/, "a branch or tag ref"))),
    sha: s(COMMIT),
    remote: s(ID),
    result: s(v.picklist(["pushed", "refused", "not_allowed"])),
    // Why, as a code the issue's Activity words without the private reason.
    code: s(v.picklist(["behind", "exists", "policy", "no_remote", "other"]), true),
    reason: priv("free_text", TEXT),
  },
  // planner-pm NEW-planner-pm-11 (PM-N11-3): a person posted the project's
  // retrospective — the sprint it looks back on, when there was one, and the
  // window its figures cover; the text a person edited is private.
  "retrospective/posted": {
    id: s(ID),
    project: s(ID),
    sprint: s(ID, true),
    from: s(TEXT),
    to: s(TEXT),
    text: priv("free_text", TEXT),
  },
  // extensibility EXT-6, EXT-7 (fix round F3 review): an MCP client's move
  // the server refused, by actor `mcp`: the tool and the column asked for (a
  // board column, else `other`); the card when it exists. Never the client's
  // reason text.
  "mcp/refused": {
    tool: s(v.picklist(["sekhemet_move_card"])),
    to: s(v.picklist([...(CARD_STATUSES as readonly string[]), "other"])),
  },
  // teams TEAM-4, integrations INT-22: a refused request, by the person's principal.
  "access/refused": {
    permission: s(ID),
    level: s(v.picklist(["viewer", "stakeholder", "member", "admin", "none"])),
    needs: s(LEVEL),
    project: s(ID, true),
  },
  // teams TEAM-15, -39, -40 (item 19): a comment on an issue, by its author's
  // principal (Seshat's answer is actor `planner`); the text is personal free
  // text, private and erasable (§3, O14). `ai` names the AI teammates it
  // mentions; `seshatMessage` the question it put in Seshat's queue.
  "issue/commented": {
    id: s(ID),
    cardId: s(ID),
    ai: s(v.array(v.picklist(["agent", "seshat"])), true),
    seshatMessage: s(ID, true),
    // teams item 23 (TEAM-21, -22): the people it mentions who can see the
    // project, and those who cannot — held back until the author answers.
    people: s(v.array(PRINCIPAL), true),
    held: s(v.array(PRINCIPAL), true),
    text: priv("free_text", TEXT),
  },
  // dashboard NEW-dashboard-10 (DB-N10-3): a Member's triage decision on an
  // untriaged Backlog issue, by their principal. *Accept into Backlog* leaves
  // the issue in Backlog and is never `card/accepted`; a Decline's reason is
  // the person's words, private and erasable.
  "issue/triaged": {
    cardId: s(ID),
    decision: s(v.picklist(["accept", "decline", "duplicate", "snooze"])),
    duplicateOf: s(ID, true),
    until: s(v.pipe(v.string(), v.isoTimestamp()), true),
    reason: priv("free_text", TEXT),
  },
  // teams item 22 (TEAM-21): the *Watch* toggle, by the person's principal.
  "issue/watched": { cardId: s(ID) },
  "issue/unwatched": { cardId: s(ID) },
  // TEAM-22: the author's answer about the people their comment mentioned
  // who cannot see the project; until it, the comment reaches no one.
  "issue/mention_answered": {
    id: s(ID),
    cardId: s(ID),
    answer: s(v.picklist(["invite", "skip"])),
  },
  // teams item 24 (TEAM-23): the Inbox's marks, by the person's principal.
  // `item` is the row (`issue:<card>`, or a request's id); `seq` the latest
  // change the mark covers, so a later change brings the row back.
  "inbox/read": { item: s(ID), seq: s(COUNT) },
  "inbox/done": { item: s(ID), seq: s(COUNT), undo: s(v.literal(true), true) },
  "inbox/snoozed": { item: s(ID), seq: s(COUNT), until: s(v.pipe(v.string(), v.isoTimestamp())) },
  "inbox/saved": { item: s(ID), saved: s(v.boolean()) },
  // teams item 19a, TEAM-39: a Stakeholder's or Viewer's `@Agent`, waiting in
  // the *Needs you* of `to` (the issue's owner, else the project lead; none:
  // the workspace's Admins). What they asked is private.
  "agent/start_requested": {
    id: s(ID),
    cardId: s(ID),
    requested_by: s(PRINCIPAL),
    to: s(PRINCIPAL, true),
    comment: s(ID, true),
    ask: priv("free_text", TEXT),
  },
  // TEAM-39: a Member started the Agent on that request (on their own behalf) or declined it.
  "agent/start_answered": {
    id: s(ID),
    answer: s(v.picklist(["started", "declined"])),
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
    // PM-P13-12: this card is the change card for that card's or test's suspect link.
    changeFor: s(ID, true),
    // design-stage DS-TO-9, DS-TO-14: a machine's proposed link, unconfirmed until `trace/confirmed`.
    proposed: s(v.literal(true), true),
  },
  "trace/confirmed": {
    requirementId: s(ID),
    version: s(v.pipe(v.number(), v.integer(), v.minValue(1))),
    from: s(v.picklist(["card", "test"])),
    ref: s(ID),
  },

  // ── B4.1 ──────────────────────────────────────────────────────────────
  // design-stage §3 (NEW-design-stage-6, DS-TO-3, SEC-55): the history's
  // secret scan — which scanner, how many commits, and each finding's commit,
  // path and rule. The secret is recorded nowhere, not even in the private
  // part. `notScanned` is the harness's reason code when the preflight refused.
  "takeover/secrets_scanned": {
    scanner: s(v.picklist(["gitleaks", "builtin"])),
    commits: s(COUNT),
    findings: s(v.array(v.strictObject({ commit: COMMIT, path: ID, rule: ID }))),
    notScanned: s(SLUG, true),
  },
  // design-stage §3 (DS-TO-5, DS-TO-7, DS-TO-8): the as-built inventory. The
  // findings' ids, kinds (`stub`, `could_not_build`, …: the detectors' own
  // slugs), paths, lines and commits are structural; the recon text read
  // from docs, issues, commit messages and transcripts, and each finding's
  // `reason` and `command`, are free text.
  "takeover/inventory": {
    baselineSeq: s(COUNT),
    findings: s(
      v.array(
        v.strictObject({
          id: ID,
          kind: SLUG,
          path: v.optional(ID),
          line: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
          commit: v.optional(COMMIT),
        }),
      ),
    ),
    recon: priv("free_text", TEXT),
    findingDetails: priv(
      "free_text",
      v.array(v.strictObject({ id: ID, reason: v.optional(TEXT), command: v.optional(TEXT) })),
    ),
    // teams TEAM-56, design-stage DS-N8-2 (DEC-57): the repository taken over;
    // a path names a person's directory, so it is private.
    root: priv("personal", TEXT),
  },
  // design-stage §3 (DS-TO-9): the brief as found — each claim's label and
  // citations (finding ids, test ids, path:line, commits); its text private.
  "takeover/brief_as_found": {
    // B4.4: the inventory it was found from, and each proven claim's executed results.
    inventorySeq: s(COUNT, true),
    claims: s(
      v.array(
        v.strictObject({
          id: ID,
          label: v.picklist(["proven", "claimed_unproven", "contradicted"]),
          citations: v.array(ID),
          results: v.optional(
            v.array(
              v.strictObject({
                kind: v.picklist(["test", "build"]),
                ref: ID,
                baselineSeq: COUNT,
              }),
            ),
          ),
        }),
      ),
    ),
    claimTexts: priv("free_text", v.array(v.strictObject({ id: ID, text: TEXT }))),
  },
  // security item 38a, SEC-54: the audit record of an approved agent
  // configuration file (repository-relative path, SHA-256, who). It grants
  // nothing on replay; the repository's real path may name a home directory.
  "trust/agent_config_approved": {
    path: s(ID),
    sha256: s(SHA256),
    principal: s(PRINCIPAL),
    repo: priv("personal", TEXT),
  },
  // ── B4.4 ──────────────────────────────────────────────────────────────
  // design-stage DS-P14-1, -3: a person's choice of depth profile, the one
  // proposed, and the test-approval level and strength rule it selects; the
  // proposal's reason is text.
  "project/depth_profile_chosen": {
    profile: s(DEPTH_PROFILE),
    projectId: s(ID, true),
    proposed: s(DEPTH_PROFILE, true),
    approval: s(v.picklist(["criteria", "must_have_examples", "every_file"])),
    strength: s(v.picklist(["advisory", "blocking"])),
    reason: priv("free_text", TEXT),
  },
  // design-stage DS-P14-5, -6, -7, DS-TO-14: a candidate requirement — its
  // source and structure; its title, criteria text and cited sources private.
  "requirement/proposed": {
    candidateId: s(ID),
    source: s(v.picklist(["model-proposal", "comparable", "takeover"])),
    projectId: s(ID, true),
    sliceId: s(ID, true),
    kano: s(v.picklist(["must-be", "performance", "attractive"]), true),
    mustHave: s(v.boolean(), true),
    criterionIds: s(v.array(CRITERION_ID), true),
    foundIn: s(v.pipe(v.number(), v.integer(), v.minValue(1)), true),
    comparableCount: s(v.pipe(v.number(), v.integer(), v.minValue(1)), true),
    walkthroughId: s(ID, true),
    stepId: s(ID, true),
    claimId: s(ID, true),
    title: priv("free_text", TEXT),
    criteria: priv("free_text", v.record(ID, TEXT)),
    sources: priv("free_text", v.array(v.strictObject({ label: TEXT, url: v.optional(TEXT) }))),
  },
  "requirement/candidate_rejected": {
    candidateId: s(ID),
    reason: priv("free_text", TEXT),
  },
  // DS-P14-7: one walk of the story map as a named user role; the role and
  // the steps' text are private, each step's supporting requirements structural.
  "walkthrough/recorded": {
    walkthroughId: s(ID),
    projectId: s(ID),
    steps: s(v.array(v.strictObject({ id: ID, requirementIds: v.array(ID) }))),
    role: priv("free_text", TEXT),
    stepTexts: priv("free_text", v.record(ID, TEXT)),
  },
  // DS-TO-11: the take-over's one batch of questions, ranked, each a decision
  // request under safe_default whose default cites a finding or claim id.
  "takeover/questions_posted": {
    inventorySeq: s(COUNT),
    questions: s(
      v.array(
        v.strictObject({
          decisionId: ID,
          rank: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(5)),
          defaultCites: ID,
          policy: v.literal("safe_default"),
        }),
      ),
    ),
  },
  // DS-TO-12: the evidenced take-over backlog; the cards' titles and links are private.
  "takeover/backlog_proposed": {
    proposalId: s(ID),
    inventorySeq: s(COUNT),
    cards: s(
      v.array(
        v.strictObject({
          ref: ID,
          bucket: v.picklist(["stabilise", "finish", "defer"]),
          change: v.optional(CARD_CHANGE),
          assignee: v.picklist(["worker", "person"]),
          forFinding: v.optional(ID),
          redCheck: v.optional(v.literal("build_fails_on_base")),
          secret: v.optional(v.strictObject({ commit: COMMIT, path: ID })),
          characterizes: v.optional(v.array(ID)),
          needsCharacterize: v.optional(v.boolean()),
        }),
      ),
    ),
    titles: priv("free_text", v.record(ID, TEXT)),
    // Each card's links — a failing test's `file > rule`, an issue's URL, a
    // file:line, a commit, a finding id — by card ref: the repository's text.
    links: priv("free_text", v.record(ID, v.array(TEXT))),
  },
  // DS-TO-14: a person approved the take-over plan (the principal on the event).
  "takeover/plan_approved": { proposalId: s(ID), inventorySeq: s(COUNT) },
  // integrations INT-42, INT-43, DS-TO-13: one verdict per inherited issue
  // with its evidence; the reasoning is private. Applied or dismissed by a person.
  "reconcile/proposed": {
    id: s(ID),
    issues: s(
      v.array(
        v.strictObject({
          issue: ISSUE,
          verdict: v.picklist(["done", "duplicate", "stale", "valid"]),
          evidence: v.array(
            v.strictObject({
              kind: v.picklist(["test", "commit", "file_line", "issue"]),
              ref: ID,
              run: v.optional(ID),
            }),
          ),
          cardId: v.optional(ID),
          newCard: v.boolean(),
        }),
      ),
    ),
    why: priv("free_text", v.record(ID, TEXT)),
  },
  "reconcile/applied": { id: s(ID) },
  "reconcile/dismissed": { id: s(ID) },
  // design-stage DS-N3-1, -3: one export — the seq the documents were
  // generated from, whether names were replaced by roles, each file's
  // repository-relative path, SHA-256 and kind; `projectId` is the project
  // whose repository received them (DEC-57), absent on an export from before.
  "docs/exported": {
    seq: s(v.pipe(v.number(), v.integer(), v.minValue(1))),
    noNames: s(v.boolean()),
    projectId: s(ID, true),
    files: s(
      v.array(
        v.strictObject({
          path: ID,
          sha256: SHA256,
          kind: v.picklist(["brief", "requirements", "decision", "changelog", "release"]),
        }),
      ),
    ),
  },
  // DS-N3-2, -5: a merged change to an exported document, one proposal per
  // difference; what the document now says is private. `headerSeq` is absent
  // for a file without the generated header.
  "docs/import_diffed": {
    path: s(ID),
    projectId: s(ID, true),
    commit: s(COMMIT),
    sha256: s(SHA256),
    headerSeq: s(COUNT, true),
    proposals: s(
      v.array(
        v.strictObject({
          id: ID,
          kind: v.picklist(["added", "removed", "changed"]),
          target: v.picklist(["brief", "requirement", "decision"]),
          targetId: v.optional(ID),
          field: v.optional(SLUG),
        }),
      ),
    ),
    proposed: priv("free_text", v.record(ID, TEXT)),
  },
  "docs/proposal_applied": { id: s(ID) },
  "docs/proposal_dismissed": { id: s(ID) },
  // planner-pm PM-P2-7: the answer reached the card that asked.
  "decision/delivered": { id: s(ID), deliveredAt: s(TEXT) },
  // planner-pm §2.10.3 (P10), DS-TO-14: a safe_default decision took its
  // default — at its deadline or on a take-over's approval; why is text, private.
  "decision/default_applied": {
    id: s(ID),
    optionIndex: s(COUNT),
    reason: priv("free_text", TEXT),
  },
  // security SEC-N10-4, models MD-N13-1: one record per scan — the depth and
  // file limits and the counts; the folders' paths are a person's, private.
  "models/scanned": {
    folderCount: s(COUNT),
    depth: s(COUNT),
    fileLimit: s(COUNT),
    found: s(COUNT),
    skipped: s(COUNT),
    truncated: s(v.boolean()),
    folders: priv("personal", v.array(TEXT)),
  },
  // dashboard DB-N6, models rule 4a (B4.1 part b): a person added or removed
  // a model folder on the Configuration page; the path names a person's
  // directory, so it is private.
  "models/folder_added": {
    principal: s(PRINCIPAL),
    includeSubfolders: s(v.boolean()),
    path: priv("personal", TEXT),
  },
  "models/folder_removed": {
    principal: s(PRINCIPAL),
    includeSubfolders: s(v.boolean(), true),
    path: priv("personal", TEXT),
  },
  // models MD-N12-6, MD-N7-1: an explicit download — the registered source
  // host, the published SHA-256, whether the file matched, and who asked.
  // Structural only: where it was written is never on the chain.
  "model/downloaded": {
    model: s(ID),
    source: s(ID),
    sha256: s(SHA256),
    bytes: s(BYTES),
    principal: s(PRINCIPAL),
    verified: s(v.boolean()),
  },
  // dashboard DB-NM14-3 (B4.1 half-B): a person's *Measure speed* on this
  // host — llama-bench's median decode and prefill and their spread (accepted
  // only at 3% or less), the first token's time without and with the prefix
  // cache, and why a part did not count. Structural only, never a path.
  "model/speed_measured": {
    model: s(ID),
    role: s(ID),
    host: s(ID),
    depth: s(COUNT),
    principal: s(PRINCIPAL),
    accepted: s(v.boolean()),
    decodeTokensPerSecond: s(MS, true),
    prefillTokensPerSecond: s(MS, true),
    spread: s(MS, true),
    ttftWithoutCacheMs: s(MS, true),
    ttftWithCacheMs: s(MS, true),
    reason: priv("free_text", TEXT),
  },
  // models MD-N14-40a, MD-N14-41, dashboard DB-NM14-8: a copy a person
  // confirmed, by the weights' key and hash and the volumes, never a path.
  "model/copied": {
    model: s(ID),
    sha256: s(SHA256),
    bytes: s(BYTES),
    from: s(VOLUME),
    to: s(VOLUME),
    principal: s(PRINCIPAL),
    verified: s(v.boolean()),
  },
  // measurement rules 36-37, MS-N5-8, MS-N5-11 (§3 contract): one combination
  // benchmarked, quick or overnight. The RunProfile can name a settings
  // file's path and contents, so it is private; its hash is on the chain.
  "measure/benchmarked": {
    tier: s(v.picklist(["quick", "overnight"])),
    profileHash: s(SHA256),
    // The host's fingerprint hash: a bake-off counts only on the host it ran on (MD-N10-1).
    host: s(ID, true),
    combination: s(v.record(v.string(), ID), true),
    partial: s(v.boolean()),
    roles: s(
      v.array(
        v.strictObject({
          role: ID,
          model: ID,
          state: v.picklist(["measured", "partial", "not_measured"]),
          cacheKey: v.optional(ID),
          setHash: v.optional(SHA256),
          score: v.optional(SCORE),
          low: v.optional(SCORE),
          high: v.optional(SCORE),
          items: v.optional(v.array(v.strictObject({ id: ID, score: SCORE }))),
          capped: v.optional(COUNT),
          secondary: v.optional(
            v.strictObject({
              secondsPerItem: v.optional(MS),
              validToolCallRate: v.optional(SCORE),
              stepsToPass: v.optional(MS),
              fits: v.boolean(),
            }),
          ),
        }),
      ),
    ),
    comparisons: s(
      v.array(
        v.strictObject({
          role: ID,
          a: ID,
          b: ID,
          better: COUNT,
          worse: COUNT,
          ties: COUNT,
          p: SCORE,
          indistinguishable: v.boolean(),
        }),
      ),
    ),
    endToEnd: s(v.strictObject({ passed: COUNT, total: COUNT }), true),
    // Overnight only (MS-N5-11): the pairs resolved and those still tied, by combination id.
    resolved: s(
      v.array(v.strictObject({ role: v.optional(ID), better: ID, worse: ID, p: SCORE })),
      true,
    ),
    indistinguishable: s(
      v.array(v.strictObject({ role: v.optional(ID), a: ID, b: ID, p: SCORE })),
      true,
    ),
    runProfile: priv("free_text", v.record(v.string(), v.unknown())),
  },
  // measurement MS-N5-6, MS-N5-12, models MD-N3-4/5 (B4.1 part (c)): a
  // benchmark run started now (quick) or queued for the overnight window,
  // and each night it resumes — the models it compares by id, the harness
  // build, context version and qualification it ran under, and, when one of
  // those changed, the run it discards and restarts with the reason's code.
  "measure/benchmark_started": {
    runId: s(ID),
    tier: s(v.picklist(["quick", "overnight"])),
    state: s(v.picklist(["queued", "running"])),
    combinations: s(v.array(v.strictObject({ id: ID, models: v.record(v.string(), ID) }))),
    host: s(ID),
    benchmarkFirst: s(v.boolean(), true),
    estimateSeconds: s(MS, true),
    build: s(ID, true),
    contextVersion: s(ID, true),
    qualification: s(ID, true),
    restartRun: s(COUNT, true),
    reason: s(SLUG, true),
  },
  // MS-N5-6, MS-N5-12, MD-N3-5: where a run stopped and why — done, a
  // person's Stop, the window's end, a reservation, a failure — how much it
  // kept, and the block and item it resumes from. A failure's message is text.
  "measure/benchmark_stopped": {
    runId: s(ID),
    tier: s(v.picklist(["quick", "overnight"])),
    reason: s(v.picklist(["done", "person", "window_end", "reserved", "failed"])),
    partial: s(v.boolean()),
    completed: s(COUNT),
    total: s(COUNT),
    cursor: s(v.strictObject({ block: COUNT, item: COUNT }), true),
    error: priv("free_text", TEXT),
  },
  // MS-N5-10, MS-N5-12: one overnight card or item completed, kept across
  // nights so a stopped run resumes from the ledger, never from memory.
  "measure/benchmark_item": {
    runId: s(ID),
    run: s(COUNT),
    block: s(COUNT),
    combinationId: s(ID),
    role: s(ID),
    item: s(ID),
    score: s(SCORE),
    seconds: s(MS),
    seed: s(COUNT),
  },
  // design-stage DS-S8-3 (amended by the owner, 2026-09-28), DS-P7-7: the
  // labelled set surveyed with keyword queries and with one Planning model's;
  // `admitted` lets that model's queries leave the machine, for its prompt only.
  "research/reuse_queries_measured": {
    model: s(ID),
    promptHash: s(SHA256),
    setHash: s(SHA256),
    n: s(COUNT),
    keywords: s(v.strictObject({ p1: SCORE, silence: SCORE, measured: COUNT })),
    modelQueries: s(v.strictObject({ p1: SCORE, silence: SCORE, measured: COUNT })),
    fromModel: s(COUNT),
    admitted: s(v.boolean()),
  },
  // planner-pm PM-P6-13, PM-N9-4 (B4.8): one run of Seshat's scripted
  // conversations — the asset's hash, the skill's version, the PM model, and
  // per conversation and run whether it met every rubric item and which it
  // missed (the rubric's own item names). The replies stay in the result file.
  "measure/seshat_evaluated": {
    assetHash: s(SHA256),
    assetVersion: s(ID),
    skillVersion: s(ID),
    model: s(ID),
    runs: s(v.array(v.strictObject({ run: COUNT, met: COUNT, total: COUNT }))),
    items: s(
      v.array(v.strictObject({ run: COUNT, id: ID, met: v.boolean(), failed: v.array(ID) })),
    ),
    passes: s(v.boolean()),
    partial: s(v.boolean()),
  },
  // review-git RG-P8-13 (B4.8): the Reviewer on the seeded-defect set —
  // recall, and each item's catch and false positives. RG-P8-16 (F25): the
  // reviews that happened, those that failed and each failure's reason (the
  // harness's own words, never the model's); optional, so older events read.
  "measure/reviewer_seeded": {
    assetHash: s(SHA256),
    assetVersion: s(ID),
    model: s(ID),
    items: s(COUNT),
    reviewed: s(COUNT, true),
    failed: s(COUNT, true),
    caught: s(COUNT),
    recall: s(SCORE),
    perItem: s(
      v.array(
        v.strictObject({
          id: ID,
          caught: v.boolean(),
          falsePositives: COUNT,
          failed: v.optional(TEXT),
        }),
      ),
    ),
    passes: s(v.boolean()),
    partial: s(v.boolean()),
  },
  // review-git RG-P8-14 (B4.8): the share of send-back reasons the AI review
  // caught before a person opened the issue, against R8's one in five.
  "measure/send_backs_caught": {
    total: s(COUNT),
    caught: s(COUNT),
    unanchored: s(COUNT),
    share: s(SCORE),
    verdict: s(v.picklist(["meets", "below", "too_few"])),
  },
  // models MD-N11-1..3, design-stage DS-N2-9: one research golden-set run —
  // per model and pipeline its measures and grades, the pipeline verdicts and
  // MD-N11-2's adoption verdicts. Each verdict's reason is free text: private.
  "research/golden_run": {
    setHash: s(SHA256),
    setVersion: s(ID),
    host: s(ID),
    items: s(COUNT),
    contenders: s(
      v.array(
        v.strictObject({
          model: ID,
          pipeline: RESEARCH_PIPELINE,
          correct: COUNT,
          n: COUNT,
          accuracy: SCORE,
          citationPrecision: SCORE,
          verifiedCitations: COUNT,
          unverifiedCitations: COUNT,
          secondsPerQuestion: MS,
          peakResidentBytes: v.optional(BYTES),
          grades: v.array(v.strictObject({ id: ID, grade: v.picklist([0, 0.5, 1]) })),
          // The questions its pipeline failed on: the contender is not measured.
          errors: v.optional(COUNT),
          benchmarkEvent: v.optional(ID),
        }),
      ),
    ),
    pipelines: s(
      v.array(
        v.strictObject({
          model: ID,
          recommended: v.optional(RESEARCH_PIPELINE),
          notRecommended: v.array(RESEARCH_PIPELINE),
          tests: v.array(
            v.strictObject({
              a: RESEARCH_PIPELINE,
              b: RESEARCH_PIPELINE,
              aRight: COUNT,
              bRight: COUNT,
              better: COUNT,
              worse: COUNT,
              p: PROBABILITY,
            }),
          ),
        }),
      ),
    ),
    adoption: s(
      v.strictObject({
        incumbent: ID,
        adopt: v.optional(ID),
        verdicts: v.array(
          v.strictObject({
            model: ID,
            allowed: v.boolean(),
            quality: v.picklist(["better", "not established", "worse", "not measured"]),
            p: PROBABILITY,
            pLoss: PROBABILITY,
          }),
        ),
      }),
    ),
    reasons: priv("free_text", v.record(v.string(), TEXT)),
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
