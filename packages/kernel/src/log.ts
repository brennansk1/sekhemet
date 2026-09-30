import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { BlobStore } from "./blobs.js";
import { canonicalJson, canonicalPayloadHash } from "./canonical_json.js";
import { checkEventPayload } from "./payload_registry.js";
import { copyDatabase } from "./sqlite_file.js";
import {
  type AppendEventParams,
  ERASED_MARKER,
  EVENT_ACTORS,
  type ErasedEventReport,
  type EventFilter,
  type EventRecord,
  type HashChainVerificationResult,
} from "./types.js";

const GENESIS_PREV_HASH = "0000000000000000000000000000000000000000000000000000000000000000";

/** The chain formula every new row is written under (NEW-kernel-1; fixed once). */
export const HASH_VERSION = 3;

/** An opaque principal id (kernel rule 19, K-N2-7): never an email or a name. */
export const PRINCIPAL_PATTERN = /^p_[0-9a-z]+$/;

/** Actors through which a person acts, so their events name that person (rule 19). */
const PERSON_ACTORS = new Set(["human", "mcp"]);

/**
 * The person a request is served for (rule 19, K-N2-8): the identity layer
 * resolves who asks and runs the request's work inside
 * {@link EventLog.actingFor}, so every `human` or `mcp` event that work
 * appends without a principal names that person — on any log over the
 * ledger, however deep the call that appends it.
 */
const actingPrincipal = new AsyncLocalStorage<string>();

export type ErasureReason = "erasure" | "secret" | "retention";

const EVENT_COLUMNS =
  "seq, id, actor, type, card_id, attempt_id, step_id, payload, payload_hash, hash, prev_hash, created_at, hash_version, principal, on_behalf_of, commitment, event_private.salt AS private_salt, event_private.body AS private_body";

/** Every reader joins the private part, so a read shows it — or the erased marker. */
const EVENT_FROM = "events LEFT JOIN event_private ON event_private.event_id = events.id";

/** A stored event row with its private part, as the chain verifier reads it. */
export interface ChainRow {
  seq: number;
  id: string;
  actor: string;
  type: string;
  card_id: string | null;
  attempt_id: string | null;
  step_id: string | null;
  payload: string;
  payload_hash: string;
  hash: string;
  prev_hash: string;
  created_at: string;
  hash_version: number | null;
  principal: string | null;
  on_behalf_of: string | null;
  commitment: string | null;
  private_salt: string | null;
  private_body: string | null;
}

type RawEventRow = ChainRow;

/** What the ledger's `ledger/erased` events say, indexed for readers and the verifier. */
export interface ErasureIndex {
  /** Erased event id → the erasing event's seq and the fields it erased. */
  byEvent: Map<string, { erasedBySeq: number; fields: string[] }>;
  /** Deleted blob id → the erasing event's seq (K-N7-8). */
  byBlob: Map<string, number>;
  /** Deleted run file (relative to `.sekhemet/`) → the erasing event's seq (RUN-57). */
  byFile: Map<string, number>;
}

/** The `ledger/erased` payload (rule 34). */
export interface LedgerErasedPayload {
  eventIds: string[];
  blobIds: string[];
  /**
   * Run files that are not content-addressed blobs — masked observations and
   * transcripts — as paths relative to `.sekhemet/` (runtime item 33,
   * RUN-57). Present only when non-empty.
   */
  files?: string[];
  /** Per erased event, the names of the private fields removed (names only). */
  fields: Record<string, string[]>;
  reason: ErasureReason;
  principal: string;
  /** Set when a restore re-applied an erasure from the register (rule 35). */
  reapplies?: string;
}

/** One line of the erasure register: ids and reasons only, no personal data (rule 35). */
export interface ErasureRegisterEntry {
  erasureId: string;
  seq: number;
  eventIds: string[];
  blobIds: string[];
  reason: ErasureReason;
  principal: string;
  at: string;
}

export interface EraseInput {
  eventIds: string[];
  blobIds?: string[];
  reason: ErasureReason;
  /** The person erasing — for `retention`, the person who set the period (rule 34). */
  principal: string;
  /** Where the named blobs live; required when `blobIds` is non-empty. */
  blobs?: BlobStore;
  /**
   * Run files to delete in the same erasure (observations, transcripts),
   * relative to `fileRoot` — the repository's `.sekhemet/` directory.
   */
  files?: string[];
  fileRoot?: string;
  /** Internal to `applyErasures`: the register entry being re-applied. */
  reapplies?: string;
}

export interface ErasureReport {
  erasedBySeq: number;
  eventIds: string[];
  blobIds: string[];
  files: string[];
  fields: Record<string, string[]>;
  /** Rule 34: what an erasure cannot reach. */
  outsideReach: string;
}

export const ERASURE_OUTSIDE_REACH =
  "Old WAL frames already copied elsewhere, file-system snapshots, backups taken before this erasure and the operating system's own copies are outside this erasure's reach.";

export interface EventLogOptions {
  /**
   * `solo` (the default): one person, whose principal a human or MCP event
   * without one carries (rule 19). `team`: such an event is refused (K-N2-1).
   */
  setup?: "solo" | "team";
  /**
   * Who holds the Accept permission (integrations.md owns identity). Solo
   * default: the install's one person; team default: no one.
   */
  mayAccept?: (principal: string) => boolean;
  /**
   * Every principal holding the Accept permission, read when an accept is
   * attempted (review-git §2.4.1): one is a solo project, two or more a team.
   * Default: the install's one person on a solo setup; no one on a team.
   */
  acceptHolders?: () => readonly string[];
  /** The erasure register every erasure appends to (rule 35), beside the backups. */
  erasureRegister?: string;
}

/** Called for every appended event matching the subscription's filter. */
/** Options of one append: the projection that commits with it (K-S7-3). */
export interface AppendOptions<T = unknown> {
  project?: (event: EventRecord<T>) => void;
}

export type EventSubscriber = (event: EventRecord) => void;

interface Subscription {
  filter: EventFilter;
  callback: EventSubscriber;
}

export class EventLog {
  private insertStmt: StatementSync;
  private insertPrivateStmt: StatementSync;
  private lastEventStmt: StatementSync;
  private selectBySeqStmt: StatementSync;
  private subscriptions = new Set<Subscription>();
  /** The last seq and hash a pass verified: incremental verification starts after it (K-N1-3). */
  private verified: { seq: number; hash: string } | undefined;
  private erasures: { atSeq: number; index: ErasureIndex } | undefined;
  private localPrincipalCache: string | undefined;
  /** The id `localPrincipal()` hands out before the local person is recorded. */
  private pendingLocalPrincipal: string | undefined;

  constructor(
    private db: DatabaseSync,
    private options: EventLogOptions = {},
  ) {
    this.insertStmt = db.prepare(`
      INSERT INTO events (id, actor, type, card_id, attempt_id, step_id, payload, payload_hash,
        hash, prev_hash, created_at, hash_version, principal, on_behalf_of, commitment)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.insertPrivateStmt = db.prepare(
      "INSERT INTO event_private (event_id, salt, body) VALUES (?, ?, ?)",
    );

    this.lastEventStmt = db.prepare(`
      SELECT ${EVENT_COLUMNS}
      FROM ${EVENT_FROM}
      ORDER BY seq DESC
      LIMIT 1
    `);

    this.selectBySeqStmt = db.prepare(`
      SELECT ${EVENT_COLUMNS}
      FROM ${EVENT_FROM}
      WHERE seq = ?
    `);
  }

  /**
   * The chain hash of one row, by its formula version — the one place each
   * formula is defined (kernel rule 9).
   *
   * v2 (no `hashVersion`): the event's identity, its association columns
   * and the payload *hash* — never the payload text, so a payload relocated
   * to a blob still verifies, and the typed columns are tamper-evident.
   *
   * v3 (`hashVersion: 3`, NEW-kernel-1): v2's fields plus `created_at`, the
   * principal, `on_behalf_of` and the commitment to the private part, as an
   * unambiguous JSON array (a `:`-joined string cannot tell a colon inside a
   * field from a separator, and a timestamp holds colons). v3 is fixed once:
   * a v4 would leave every v3 row unerasable.
   */
  public static computeHash(input: {
    prevHash: string;
    seq: number;
    actor: string;
    type: string;
    payloadHash: string;
    id: string;
    cardId?: string | null;
    attemptId?: string | null;
    stepId?: string | null;
    hashVersion?: number | null;
    createdAt?: string;
    principal?: string | null;
    onBehalfOf?: string | null;
    commitment?: string | null;
  }): string {
    if (input.hashVersion === 3) {
      const fields = [
        "sekhemet-ledger-v3",
        input.prevHash,
        input.seq,
        input.actor,
        input.type,
        input.cardId ?? null,
        input.attemptId ?? null,
        input.stepId ?? null,
        input.payloadHash,
        input.id,
        input.createdAt ?? "",
        input.principal ?? null,
        input.onBehalfOf ?? null,
        input.commitment ?? null,
      ];
      return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
    }
    const parts = [
      input.prevHash,
      String(input.seq),
      input.actor,
      input.type,
      input.cardId ?? "",
      input.attemptId ?? "",
      input.stepId ?? "",
      input.payloadHash,
      input.id,
    ];
    return createHash("sha256").update(parts.join(":")).digest("hex");
  }

  /** `SHA-256(salt ‖ canonical(private))` (rule 33); `body` is the canonical JSON. */
  public static commitmentOf(saltHex: string, body: string): string {
    return createHash("sha256")
      .update(Buffer.concat([Buffer.from(saltHex, "hex"), Buffer.from(body, "utf8")]))
      .digest("hex");
  }

  private mapRow<T>(row: RawEventRow): EventRecord<T> {
    let privatePart: Record<string, unknown> | undefined;
    let erasedBySeq: number | undefined;
    if (row.private_body !== null && row.private_body !== undefined) {
      privatePart = JSON.parse(row.private_body) as Record<string, unknown>;
    } else if (row.commitment) {
      const erased = this.erasureIndex().byEvent.get(row.id);
      if (erased) {
        erasedBySeq = erased.erasedBySeq;
        privatePart = Object.fromEntries(erased.fields.map((f) => [f, ERASED_MARKER]));
      }
    }
    return {
      seq: row.seq,
      id: row.id,
      actor: row.actor,
      type: row.type,
      payload: JSON.parse(row.payload) as T,
      payloadHash: row.payload_hash,
      hash: row.hash,
      prevHash: row.prev_hash,
      createdAt: row.created_at,
      ...(row.card_id ? { cardId: row.card_id } : {}),
      ...(row.attempt_id ? { attemptId: row.attempt_id } : {}),
      ...(row.step_id ? { stepId: row.step_id } : {}),
      ...(row.hash_version ? { hashVersion: row.hash_version } : {}),
      ...(row.principal ? { principal: row.principal } : {}),
      ...(row.on_behalf_of ? { onBehalfOf: row.on_behalf_of } : {}),
      ...(row.commitment ? { commitment: row.commitment } : {}),
      ...(privatePart ? { private: privatePart } : {}),
      ...(erasedBySeq !== undefined ? { erasedBySeq } : {}),
    };
  }

  /** Refusals that need no database read: actor, principal and `on_behalf_of` shape. */
  private validate(params: AppendEventParams<unknown>): void {
    // K5: the table's CHECK refuses an unknown actor too; this says which.
    if (!(EVENT_ACTORS as readonly string[]).includes(params.actor)) {
      throw new Error(
        `Unknown event actor "${params.actor}"; the ledger accepts ${EVENT_ACTORS.join(", ")}`,
      );
    }
    // Only `erase` records an erasure, in the transaction that deletes the rows:
    // a bare `ledger/erased` would name gaps nobody made (rule 34).
    if (params.type === "ledger/erased") {
      throw new Error("A ledger/erased event is recorded only by EventLog.erase (kernel rule 34)");
    }
    // The registry: the payload's schema and data classes (K-S7-4, K-S7-9).
    checkEventPayload(params.type, params.payload, params.private);
    if (params.principal !== undefined && !PRINCIPAL_PATTERN.test(params.principal)) {
      throw new Error(
        `A principal is an opaque id matching ${PRINCIPAL_PATTERN} — never an email or a name (kernel rule 19)`,
      );
    }
    if (params.actor === "worker" && params.principal !== undefined) {
      throw new Error(
        "The Worker's events carry no principal: the person it acts for is on_behalf_of (kernel rule 19, K-N10-1)",
      );
    }
    if (params.onBehalfOf !== undefined) {
      if (params.actor !== "worker") {
        throw new Error(
          `on_behalf_of is only for events the Worker writes (actor was ${params.actor}; kernel rule 19)`,
        );
      }
      if (!PRINCIPAL_PATTERN.test(params.onBehalfOf)) {
        throw new Error(`on_behalf_of is an opaque id matching ${PRINCIPAL_PATTERN}`);
      }
    }
    if (
      params.private !== undefined &&
      (params.private === null ||
        typeof params.private !== "object" ||
        Array.isArray(params.private))
    ) {
      throw new Error("An event's private part is an object of named fields (kernel rule 33)");
    }
  }

  /** The principal of the install's recorded local person, if there is one. */
  private recordedLocalPerson(): string | undefined {
    const row = this.db
      .prepare(
        "SELECT principal FROM events WHERE type = 'person/created' AND principal IS NOT NULL AND json_extract(payload, '$.local') = 1 ORDER BY seq DESC LIMIT 1",
      )
      .get() as { principal: string } | undefined;
    return row?.principal;
  }

  /**
   * The install's one person on a solo setup (rule 19): the principal of the
   * local `person/created {local: true}` record — never another principal on
   * the ledger, which may be a named person (review B3.1). With none recorded
   * yet, a fresh id that the first append carrying it records as the local
   * person, in that append's transaction. Cached only once the ledger holds
   * it, so two logs over one database agree.
   */
  /**
   * Run `fn` for `principal` (rule 19, K-N2-8): a `human` or `mcp` event
   * appended inside it without a principal carries this one. An explicit
   * principal still wins, a machine event stays unattributed (K-N2-6), and
   * outside every scope a team log still refuses such an event (K-N2-1).
   */
  public static actingFor<T>(principal: string, fn: () => T): T {
    if (!PRINCIPAL_PATTERN.test(principal)) {
      throw new Error(`A principal is an opaque id (p_…), never "${principal}" (K-N2-7)`);
    }
    return actingPrincipal.run(principal, fn);
  }

  /**
   * Run `fn` outside any person's scope: work that outlives the request that
   * started it (a background loop serving several people) names each person
   * itself, never the one who happened to start it.
   */
  public static unscoped<T>(fn: () => T): T {
    return actingPrincipal.exit(fn);
  }

  public localPrincipal(): string {
    if (this.localPrincipalCache) return this.localPrincipalCache;
    const recorded = this.recordedLocalPerson();
    if (recorded) {
      this.localPrincipalCache = recorded;
      return recorded;
    }
    this.pendingLocalPrincipal ??= `p_${randomBytes(12).toString("hex")}`;
    return this.pendingLocalPrincipal;
  }

  /**
   * The solo install's person record (rule 19): `person/created` with the
   * opaque principal in the payload and the email and name only in the
   * private part. Idempotent; returns the principal.
   */
  public ensureLocalPerson(details: { email?: string; name?: string }): string {
    const existing = this.recordedLocalPerson();
    if (existing) return existing;
    const principal = this.localPrincipal();
    const personal = Object.fromEntries(
      Object.entries(details).filter(([, v]) => typeof v === "string" && v.trim() !== ""),
    );
    this.appendNow({
      actor: "system",
      type: "person/created",
      payload: { principal, local: true },
      principal,
      ...(Object.keys(personal).length > 0 ? { private: personal } : {}),
    });
    this.localPrincipalCache = principal;
    return principal;
  }

  /** Whether `principal` holds the Accept permission (K-N7-1). */
  public mayAccept(principal: string): boolean {
    if (this.options.mayAccept) return this.options.mayAccept(principal);
    if (this.options.acceptHolders) return this.options.acceptHolders().includes(principal);
    if ((this.options.setup ?? "solo") === "team") return false;
    return principal === this.localPrincipal();
  }

  /** Every Accept-holder now (review-git §2.4.1), counted when an accept is attempted. */
  public acceptHolders(): string[] {
    if (this.options.acceptHolders) return [...new Set(this.options.acceptHolders())];
    if ((this.options.setup ?? "solo") === "team") return [];
    return [this.localPrincipal()];
  }

  /** The principal who recorded the card's latest delegation to the Worker (review-git §2.4.1). */
  public delegatorOf(cardId: string): string | undefined {
    return this.delegatingPrincipal(cardId) ?? undefined;
  }

  public async append<T = unknown>(
    params: AppendEventParams<T>,
    options: AppendOptions<T> = {},
  ): Promise<EventRecord<T>> {
    return this.appendNow(params, options);
  }

  /**
   * `append`, synchronously (the database is synchronous; the harness opens it so).
   *
   * `options.project` projects the recorded event inside the same transaction,
   * before `COMMIT` (S7, K-S7-3): when it throws, the append rolls back with
   * it, so a projection failure can never leave a poison event behind.
   */
  public appendNow<T = unknown>(
    params: AppendEventParams<T>,
    options: AppendOptions<T> = {},
  ): EventRecord<T> {
    this.validate(params);
    this.db.exec("BEGIN IMMEDIATE");
    let inserted: EventRecord<T>;
    try {
      inserted = this.appendInTransaction(params);
      options.project?.(inserted);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    // Notified only after COMMIT, so a subscriber can never observe — or act
    // on — an event that a later failure rolled back.
    this.notify(inserted as EventRecord);
    return inserted;
  }

  /**
   * Several appends, each with its projection, as one transaction (K-S7-3):
   * all commit or none do. Subscribers are notified after `COMMIT`, in order.
   */
  public appendAllNow(
    entries: readonly {
      params: AppendEventParams<unknown>;
      project?: (event: EventRecord) => void;
    }[],
  ): EventRecord[] {
    for (const e of entries) this.validate(e.params);
    this.db.exec("BEGIN IMMEDIATE");
    const inserted: EventRecord[] = [];
    try {
      for (const e of entries) {
        const record = this.appendInTransaction(e.params) as EventRecord;
        e.project?.(record);
        inserted.push(record);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    for (const record of inserted) this.notify(record);
    return inserted;
  }

  /**
   * Append inside a write transaction the caller already holds — a numbered
   * migration's (rule 38). Validated as any append; subscribers are not
   * notified, since the caller's COMMIT is not this method's to see.
   */
  public appendWithinTransaction<T = unknown>(params: AppendEventParams<T>): EventRecord<T> {
    this.validate(params);
    return this.appendInTransaction(params);
  }

  /** The principal who recorded the card's latest delegation to the Worker, if any (K-N10-1). */
  private delegatingPrincipal(cardId: string): string | null {
    const row = this.db
      .prepare(
        "SELECT principal FROM events WHERE card_id = ? AND type = 'card/delegated' AND json_extract(payload, '$.to.kind') = 'worker' ORDER BY seq DESC LIMIT 1",
      )
      .get(cardId) as { principal: string | null } | undefined;
    return row?.principal ?? null;
  }

  /** The append itself; the caller holds the write transaction. */
  private appendInTransaction<T>(params: AppendEventParams<T>): EventRecord<T> {
    const id = params.id ?? randomUUID();
    const payloadStr = JSON.stringify(params.payload);
    const payloadHash = canonicalPayloadHash(params.payload);
    const cardId = params.cardId ?? null;
    const attemptId = params.attemptId ?? null;
    const stepId = params.stepId ?? null;
    let principal =
      params.principal ??
      (PERSON_ACTORS.has(params.actor) ? (actingPrincipal.getStore() ?? null) : null);
    if (principal === null && PERSON_ACTORS.has(params.actor)) {
      if ((this.options.setup ?? "solo") === "team") {
        throw new Error(
          `An event with actor ${params.actor} names the person it acts for: no principal was given (kernel rule 19, K-N2-1)`,
        );
      }
      principal = this.localPrincipal();
    }
    // Rule 19: the install's person, first carried, is recorded as the local
    // person in the same transaction — so it is never inferred from whichever
    // principal happens to come first on the ledger.
    if (
      principal !== null &&
      principal === this.pendingLocalPrincipal &&
      params.type !== "person/created" &&
      this.recordedLocalPerson() === undefined
    ) {
      this.appendInTransaction({
        actor: "system",
        type: "person/created",
        payload: { principal, local: true },
        principal,
      });
    }
    // K-N10-1: the Worker acts for the person whose latest delegation of the
    // card to it is recorded — named in on_behalf_of, never as principal.
    const onBehalfOf =
      params.onBehalfOf ??
      (params.actor === "worker" && cardId !== null ? this.delegatingPrincipal(cardId) : null);
    let privateRow: { salt: string; body: string } | undefined;
    let commitment: string | null = null;
    if (params.private !== undefined) {
      const salt = randomBytes(32).toString("hex");
      const body = canonicalJson(params.private);
      privateRow = { salt, body };
      commitment = EventLog.commitmentOf(salt, body);
    }
    const createdAt = new Date().toISOString();

    const lastRow = this.lastEventStmt.get() as unknown as RawEventRow | undefined;
    const prevHash = lastRow ? lastRow.hash : GENESIS_PREV_HASH;
    const nextSeq = lastRow ? lastRow.seq + 1 : 1;
    const hash = EventLog.computeHash({
      prevHash,
      seq: nextSeq,
      actor: params.actor,
      type: params.type,
      payloadHash,
      id,
      cardId,
      attemptId,
      stepId,
      hashVersion: HASH_VERSION,
      createdAt,
      principal,
      onBehalfOf,
      commitment,
    });

    const runResult = this.insertStmt.run(
      id,
      params.actor,
      params.type,
      cardId,
      attemptId,
      stepId,
      payloadStr,
      payloadHash,
      hash,
      prevHash,
      createdAt,
      HASH_VERSION,
      principal,
      onBehalfOf,
      commitment,
    );
    if (privateRow) this.insertPrivateStmt.run(id, privateRow.salt, privateRow.body);
    const insertedSeq = Number(runResult.lastInsertRowid);
    const insertedRow = this.selectBySeqStmt.get(insertedSeq) as unknown as RawEventRow;
    return this.mapRow<T>(insertedRow);
  }

  /**
   * Stream appended events instead of polling the table.
   *
   * WHY: the dashboard's only alternative is re-querying the log on a timer,
   * which is both late and expensive on a board that is idle most of the time.
   * The subscription is in-process — it sees writes from this `EventLog`
   * instance, not from another process holding the same WAL file, which is the
   * correct scope for a local-first single-writer harness.
   *
   * Returns an unsubscribe function. Safe to call during dispatch.
   */
  public subscribe(filter: EventFilter, callback: EventSubscriber): () => void {
    const subscription: Subscription = { filter, callback };
    this.subscriptions.add(subscription);
    return () => {
      this.subscriptions.delete(subscription);
    };
  }

  private notify(event: EventRecord): void {
    // Iterate a snapshot: a subscriber that unsubscribes itself (or another)
    // while being notified must not perturb this dispatch.
    for (const subscription of [...this.subscriptions]) {
      if (!this.subscriptions.has(subscription)) continue;
      const { filter } = subscription;
      if (filter.cardId !== undefined && event.cardId !== filter.cardId) continue;
      if (filter.type !== undefined && event.type !== filter.type) continue;
      if (filter.actor !== undefined && event.actor !== filter.actor) continue;
      try {
        // A subscriber serves everyone, not the person whose append woke it:
        // it and any work it schedules run outside the appender's scope (K-N2-8).
        EventLog.unscoped(() => subscription.callback(event));
      } catch {
        // A broken listener must not fail the append that already committed:
        // the log is the source of truth and its durability cannot depend on
        // whatever a UI or plugin does with the notification.
      }
    }
  }

  public async getLastEvent(): Promise<EventRecord | null> {
    const row = this.lastEventStmt.get() as unknown as RawEventRow | undefined;
    if (!row) return null;
    return this.mapRow(row);
  }

  public async getEvents(fromSeq = 1, limit = 1000): Promise<EventRecord[]> {
    const rows = this.db
      .prepare(`
        SELECT ${EVENT_COLUMNS}
        FROM ${EVENT_FROM}
        WHERE seq >= ?
        ORDER BY seq ASC
        LIMIT ?
      `)
      .all(fromSeq, limit) as unknown as RawEventRow[];

    return rows.map((r) => this.mapRow(r));
  }

  /**
   * Every event of the given types, in order, from `fromSeq`.
   *
   * Uses the `type` index: the PM conversation and cycles are a few hundred
   * rows inside a ledger that grows by one `card/step` per Worker turn, and
   * scanning the whole chain to find them would grow with every run.
   */
  public async getEventsByTypes(
    types: string[],
    fromSeq = 1,
    limit = 10_000,
  ): Promise<EventRecord[]> {
    if (types.length === 0) return [];
    const rows = this.db
      .prepare(`
        SELECT ${EVENT_COLUMNS}
        FROM ${EVENT_FROM}
        WHERE seq >= ? AND type IN (${types.map(() => "?").join(", ")})
        ORDER BY seq ASC
        LIMIT ?
      `)
      .all(fromSeq, ...types, limit) as unknown as RawEventRow[];
    return rows.map((r) => this.mapRow(r));
  }

  /**
   * The first event recorded at or after `iso` (an ISO time), by the
   * `created_at` index; undefined when none is. A reader of a time window
   * starts there instead of at the chain's beginning (Insights' model use).
   * Times follow the host's clock, so a reader still filters by time.
   */
  public async firstSeqSince(iso: string): Promise<number | undefined> {
    const row = this.db
      .prepare("SELECT MIN(seq) AS seq FROM events WHERE created_at >= ?")
      .get(iso) as { seq: number | null } | undefined;
    return row?.seq ?? undefined;
  }

  /**
   * Every event belonging to one card, in order.
   *
   * This is the query the typed `card_id` column exists for: before it, card
   * association lived inside the payload JSON and the only way to answer it was
   * a full scan plus a JSON parse per row.
   */
  public async getEventsByCard(cardId: string, limit = 1000): Promise<EventRecord[]> {
    const rows = this.db
      .prepare(`
        SELECT ${EVENT_COLUMNS}
        FROM ${EVENT_FROM}
        WHERE card_id = ?
        ORDER BY seq ASC
        LIMIT ?
      `)
      .all(cardId, limit) as unknown as RawEventRow[];

    return rows.map((r) => this.mapRow(r));
  }

  /**
   * One card's events of the given types, in order, without the per-card
   * limit a long card's `card/step` stream would otherwise exhaust.
   */
  public async getEventsByCardAndTypes(
    cardId: string,
    types: string[],
    limit = 10_000,
  ): Promise<EventRecord[]> {
    if (types.length === 0) return [];
    const rows = this.db
      .prepare(`
        SELECT ${EVENT_COLUMNS}
        FROM ${EVENT_FROM}
        WHERE card_id = ? AND type IN (${types.map(() => "?").join(", ")})
        ORDER BY seq ASC
        LIMIT ?
      `)
      .all(cardId, ...types, limit) as unknown as RawEventRow[];
    return rows.map((r) => this.mapRow(r));
  }

  /**
   * Verify the chain (kernel rules 10–11). Incremental by default: it starts
   * after the last seq this log verified, provided that row still carries the
   * hash it had, and re-hashes only newer rows (K-N1-3); `full` re-hashes
   * every row and re-checks every private part. `sekhemet log` runs full.
   */
  public async verifyHashChain(
    options: { full?: boolean } = {},
  ): Promise<HashChainVerificationResult> {
    return this.verifyHashChainSync(options);
  }

  /**
   * The chain check, synchronously: a migration runs while the database is
   * being opened, and the harness serves nothing until the check passes
   * (kernel rule 38, K-N4-5).
   */
  public verifyHashChainSync(options: { full?: boolean } = {}): HashChainVerificationResult {
    let fromSeq = 1;
    let prevHash = GENESIS_PREV_HASH;
    if (!options.full && this.verified) {
      const row = this.db.prepare("SELECT hash FROM events WHERE seq = ?").get(this.verified.seq) as
        | { hash: string }
        | undefined;
      if (row?.hash === this.verified.hash) {
        fromSeq = this.verified.seq + 1;
        prevHash = this.verified.hash;
      }
    }
    const rows = readChainRows(this.db, fromSeq);
    const total = (this.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
    const index = this.erasureIndex();
    const seqStmt = this.db.prepare("SELECT seq FROM events WHERE id = ?");
    const result = verifyChainRows(rows, {
      fromSeq,
      prevHash,
      erasures: index,
      totalEvents: total,
      seqOfEvent: (id) => (seqStmt.get(id) as { seq: number } | undefined)?.seq,
    });
    if (result.valid) {
      const last = rows[rows.length - 1];
      if (last) this.verified = { seq: last.seq, hash: last.hash };
    } else {
      this.verified = undefined;
    }
    return result;
  }

  /**
   * The ledger's erasures, re-read whenever a newer `ledger/erased` exists —
   * from this log or another connection to the same file.
   */
  public erasureIndex(): ErasureIndex {
    const latest = (
      this.db.prepare("SELECT MAX(seq) AS s FROM events WHERE type = 'ledger/erased'").get() as {
        s: number | null;
      }
    ).s;
    const atSeq = latest ?? 0;
    if (this.erasures && this.erasures.atSeq === atSeq) return this.erasures.index;
    const rows = this.db
      .prepare("SELECT seq, payload FROM events WHERE type = 'ledger/erased' ORDER BY seq ASC")
      .all() as unknown as { seq: number; payload: string }[];
    const index = erasureIndexOf(rows.map((r) => ({ seq: r.seq, payload: r.payload })));
    this.erasures = { atSeq, index };
    return index;
  }

  /** Whether the ledger holds an event with this id. */
  public hasEvent(id: string): boolean {
    return this.db.prepare("SELECT 1 AS x FROM events WHERE id = ?").get(id) !== undefined;
  }

  /** The last seq, 0 on an empty ledger. */
  public lastSeq(): number {
    return (this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM events").get() as { s: number })
      .s;
  }

  /** Whether a register entry is on this ledger: as the erasure itself, or re-applied (rule 35). */
  public erasureApplied(erasureId: string): boolean {
    return (
      this.db
        .prepare(
          "SELECT 1 AS x FROM events WHERE type = 'ledger/erased' AND (id = ? OR json_extract(payload, '$.reapplies') = ?)",
        )
        .get(erasureId, erasureId) !== undefined
    );
  }

  /** The `ledger/erased` seq that erased this event's private part, if any. */
  public erasureOf(eventId: string): number | undefined {
    return this.erasureIndex().byEvent.get(eventId)?.erasedBySeq;
  }

  /** The `ledger/erased` seq that deleted this blob, if any (K-N7-6, K-N7-8). */
  public blobErasure(blobId: string): number | undefined {
    return this.erasureIndex().byBlob.get(blobId);
  }

  /**
   * The events whose private part contains `needle` (rule 34, K-N7-7): a
   * read of `event_private` only. The needle is bound as a parameter and
   * never written to the ledger, a log or a blob. A body is canonical JSON,
   * so the needle is matched in its JSON-escaped form.
   */
  public findPrivate(needle: string): EventRecord[] {
    if (needle === "") return [];
    const escaped = JSON.stringify(needle).slice(1, -1);
    const rows = this.db
      .prepare(
        `SELECT ${EVENT_COLUMNS} FROM ${EVENT_FROM}
         WHERE events.id IN (SELECT event_id FROM event_private WHERE instr(body, ?) > 0)
         ORDER BY seq ASC`,
      )
      .all(escaped) as unknown as RawEventRow[];
    return rows.map((r) => this.mapRow(r));
  }

  /**
   * The seqs whose structural `payload` contains `needle` (SEC-50): content
   * the chain covers, which no erasure can remove — rotating the secret is
   * the remedy. A read only; the needle is bound, never written anywhere.
   */
  public findInPayload(needle: string): number[] {
    if (needle === "") return [];
    const escaped = JSON.stringify(needle).slice(1, -1);
    const rows = this.db
      .prepare("SELECT seq FROM events WHERE instr(payload, ?) > 0 ORDER BY seq ASC")
      .all(escaped) as unknown as { seq: number }[];
    return rows.map((r) => r.seq);
  }

  /**
   * Delete every blob a recorded erasure named that is still on disk (rule
   * 34, K-N7-8): an erasure deletes its blobs after `COMMIT`, so a crash in
   * between leaves the file; opening the ledger finishes the deletion.
   * Returns the ids it deleted.
   */
  public retryBlobErasures(blobs: Pick<BlobStore, "has" | "delete">): string[] {
    const deleted: string[] = [];
    for (const id of this.erasureIndex().byBlob.keys()) {
      if (blobs.has(id) && blobs.delete(id)) deleted.push(id);
    }
    return deleted;
  }

  /**
   * Delete every run file a recorded erasure named that a crash left on disk
   * (RUN-57), as `retryBlobErasures` does for blobs. `root` is `.sekhemet/`.
   */
  public retryFileErasures(root: string): string[] {
    const deleted: string[] = [];
    for (const f of this.erasureIndex().byFile.keys()) {
      if (isRunFilePath(f) && deleteRunFile(root, f)) deleted.push(f);
    }
    return deleted;
  }

  /**
   * Erase the private parts of events, and blobs, as one recorded erasure
   * (kernel rule 34, K-N7-1): only a person holding the Accept permission;
   * `secure_delete` on; the rows deleted and `ledger/erased` appended in one
   * transaction; the blobs deleted once that commits (a crash between leaves a
   * recorded erasure whose re-application deletes them, never an unrecorded
   * gap); the erasure register appended; the WAL checkpointed.
   */
  public async erase(input: EraseInput): Promise<ErasureReport> {
    const reasons: readonly ErasureReason[] = ["erasure", "secret", "retention"];
    if (!reasons.includes(input.reason)) {
      throw new Error(`An erasure's reason is one of ${reasons.join(", ")}`);
    }
    if (!PRINCIPAL_PATTERN.test(input.principal)) {
      throw new Error(`An erasure names the person as an opaque id matching ${PRINCIPAL_PATTERN}`);
    }
    // A re-application copies a decision already made and recorded (rule 35).
    if (input.reapplies === undefined && !this.mayAccept(input.principal)) {
      throw new Error(
        `Only a person holding the Accept permission may erase; ${input.principal} does not (kernel rule 34, K-N7-1)`,
      );
    }
    const blobIds = [...new Set(input.blobIds ?? [])];
    if (blobIds.length > 0 && !input.blobs) throw new Error("Erasing blobs needs the blob store");
    const files = [...new Set(input.files ?? [])];
    if (files.length > 0 && !input.fileRoot) throw new Error("Erasing files needs their root");
    for (const f of files) {
      if (!isRunFilePath(f)) throw new Error(`Not a run file path under .sekhemet/: ${f}`);
    }
    const eventIds = [...new Set(input.eventIds)];

    this.db.exec("PRAGMA secure_delete = ON");
    this.db.exec("BEGIN IMMEDIATE");
    let erased: EventRecord<LedgerErasedPayload>;
    try {
      const exists = this.db.prepare("SELECT 1 AS x FROM events WHERE id = ?");
      const bodyOf = this.db.prepare("SELECT body FROM event_private WHERE event_id = ?");
      const remove = this.db.prepare("DELETE FROM event_private WHERE event_id = ?");
      const erasedIds: string[] = [];
      const fields: Record<string, string[]> = {};
      for (const id of eventIds) {
        if (!exists.get(id)) throw new Error(`No event ${id} to erase`);
        const row = bodyOf.get(id) as { body: string } | undefined;
        if (!row) continue; // no private part, or erased already
        fields[id] = Object.keys(JSON.parse(row.body) as Record<string, unknown>).sort();
        remove.run(id);
        erasedIds.push(id);
      }
      if (erasedIds.length === 0 && blobIds.length === 0 && files.length === 0) {
        throw new Error(
          "Nothing to erase: no named event has a private part, and no blob or file is named",
        );
      }
      const payload: LedgerErasedPayload = {
        eventIds: erasedIds,
        blobIds,
        ...(files.length > 0 ? { files } : {}),
        fields,
        reason: input.reason,
        principal: input.principal,
        ...(input.reapplies !== undefined ? { reapplies: input.reapplies } : {}),
      };
      erased = this.appendInTransaction<LedgerErasedPayload>({
        // A retention erasure is run by a job for the person who set the period.
        actor: input.reason === "retention" ? "harness" : "human",
        type: "ledger/erased",
        payload,
        principal: input.principal,
      });
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    this.erasures = undefined;
    for (const id of blobIds) input.blobs?.delete(id);
    if (input.fileRoot) for (const f of files) deleteRunFile(input.fileRoot, f);
    if (input.reapplies === undefined && this.options.erasureRegister) {
      appendErasureRegister(this.options.erasureRegister, {
        erasureId: erased.id,
        seq: erased.seq,
        eventIds: erased.payload.eventIds,
        blobIds,
        reason: input.reason,
        principal: input.principal,
        at: erased.createdAt,
      });
    }
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.notify(erased as EventRecord);
    return {
      erasedBySeq: erased.seq,
      eventIds: erased.payload.eventIds,
      blobIds,
      files,
      fields: erased.payload.fields,
      outsideReach: ERASURE_OUTSIDE_REACH,
    };
  }

  /**
   * A consistent copy of the ledger while writers continue (kernel rule 35,
   * K-N7-4): `VACUUM INTO` (see `copyDatabase` for why not `backup()`). The
   * copy's chain is verified, then `ledger/backed_up {path, seq}` records it,
   * `seq` being the last event the copy holds.
   */
  public async backup(
    path: string,
    options: { principal?: string } = {},
  ): Promise<{ path: string; seq: number }> {
    copyDatabase(this.db, path);
    const { DatabaseSync } = await import("node:sqlite");
    const copy = new DatabaseSync(path, { readOnly: true });
    let seq: number;
    try {
      const check = new EventLog(copy).verifyHashChainSync({ full: true });
      if (!check.valid) {
        throw new Error(
          `The backup at ${path} does not verify: ${check.reason ?? "invalid chain"}`,
        );
      }
      seq = (copy.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM events").get() as { s: number })
        .s;
    } finally {
      copy.close();
    }
    await this.append({
      actor: "harness",
      type: "ledger/backed_up",
      payload: { path, seq },
      ...(options.principal ? { principal: options.principal } : {}),
    });
    return { path, seq };
  }
}

/** Every row of the chain with its private part, in seq order (the export reads these). */
export function readChainRows(db: DatabaseSync, fromSeq = 1): ChainRow[] {
  return db
    .prepare(`SELECT ${EVENT_COLUMNS} FROM ${EVENT_FROM} WHERE seq >= ? ORDER BY seq ASC`)
    .all(fromSeq) as unknown as ChainRow[];
}

/**
 * The erasures a ledger records, read from any connection — a read-only one
 * included — so a replay names an erased pack as a gap (K-N7-6).
 */
export function ledgerErasures(db: DatabaseSync): ErasureIndex {
  const rows = db
    .prepare("SELECT seq, payload FROM events WHERE type = 'ledger/erased' ORDER BY seq ASC")
    .all() as unknown as { seq: number; payload: string }[];
  return erasureIndexOf(rows);
}

/** Index `ledger/erased` events (rows of seq and payload text). */
export function erasureIndexOf(rows: readonly { seq: number; payload: string }[]): ErasureIndex {
  const byEvent = new Map<string, { erasedBySeq: number; fields: string[] }>();
  const byBlob = new Map<string, number>();
  const byFile = new Map<string, number>();
  for (const r of rows) {
    const p = JSON.parse(r.payload) as Partial<LedgerErasedPayload>;
    for (const id of p.eventIds ?? []) {
      if (!byEvent.has(id)) byEvent.set(id, { erasedBySeq: r.seq, fields: p.fields?.[id] ?? [] });
    }
    for (const id of p.blobIds ?? []) if (!byBlob.has(id)) byBlob.set(id, r.seq);
    for (const f of p.files ?? []) if (!byFile.has(f)) byFile.set(f, r.seq);
  }
  return { byEvent, byBlob, byFile };
}

/**
 * Verify rows of the chain in seq order, from `fromSeq` after `prevHash`:
 * each row by its own formula version (rule 11), its stored payload hash,
 * and its private part — present and matching the commitment, or removed by
 * a `ledger/erased` event later in the ledger (rule 34). Shared by the
 * ledger and the NDJSON export's verifier (RUN-42), so both reach one verdict.
 */
export function verifyChainRows(
  rows: readonly ChainRow[],
  context: {
    fromSeq?: number;
    prevHash?: string;
    erasures: ErasureIndex;
    totalEvents?: number;
    /** Export without private parts (RUN-43): commitments are checked in the chain only. */
    privateOmitted?: boolean;
    /** The seq of an event outside `rows` (incremental verification), to list its erasure. */
    seqOfEvent?: (id: string) => number | undefined;
  },
): HashChainVerificationResult {
  let prevHash = context.prevHash ?? GENESIS_PREV_HASH;
  const fromSeq = context.fromSeq ?? 1;
  const totalEvents = context.totalEvents ?? fromSeq - 1 + rows.length;
  const corrupt = (seq: number, reason: string): HashChainVerificationResult => ({
    valid: false,
    totalEvents,
    corruptedSeq: seq,
    reason,
    hashedEvents: rows.length,
  });
  const seqOf = new Map<string, number>();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const expectedSeq = fromSeq + i;
    seqOf.set(row.id, row.seq);

    if (row.seq !== expectedSeq) {
      return corrupt(row.seq, `Non-monotonic sequence: expected ${expectedSeq}, got ${row.seq}`);
    }
    if (row.prev_hash !== prevHash) {
      return corrupt(
        row.seq,
        `Invalid prevHash at seq ${row.seq}: expected ${prevHash}, got ${row.prev_hash}`,
      );
    }

    // Recomputed from the stored payload rather than trusted from the
    // payload_hash column, so editing the payload breaks the chain even if
    // the column is left alone.
    const isLegacyRow = row.payload_hash === "";
    const recomputedPayloadHash = isLegacyRow
      ? ""
      : canonicalPayloadHash(JSON.parse(row.payload) as unknown);
    const version = row.hash_version ?? null;
    if (version !== null && version !== HASH_VERSION) {
      return corrupt(row.seq, `Unknown chain formula version ${version} at seq ${row.seq}`);
    }

    const expectedHash = isLegacyRow
      ? legacyHash(row)
      : EventLog.computeHash({
          prevHash: row.prev_hash,
          seq: row.seq,
          actor: row.actor,
          type: row.type,
          payloadHash: recomputedPayloadHash,
          id: row.id,
          cardId: row.card_id,
          attemptId: row.attempt_id,
          stepId: row.step_id,
          hashVersion: version,
          createdAt: row.created_at,
          principal: row.principal,
          onBehalfOf: row.on_behalf_of,
          commitment: row.commitment,
        });

    if (row.hash !== expectedHash) {
      return corrupt(
        row.seq,
        `Hash mismatch at seq ${row.seq}: expected ${expectedHash}, got ${row.hash}`,
      );
    }

    // The chain check above cannot see an edit that touched only the
    // payload_hash column, since it recomputes that value; compare it
    // explicitly so the stored digest is covered too.
    if (!isLegacyRow && row.payload_hash !== recomputedPayloadHash) {
      return corrupt(
        row.seq,
        `Stored payload hash mismatch at seq ${row.seq}: expected ${recomputedPayloadHash}, got ${row.payload_hash}`,
      );
    }

    const hasPrivate = row.private_body !== null && row.private_body !== undefined;
    if (row.commitment) {
      if (hasPrivate) {
        if (
          EventLog.commitmentOf(row.private_salt ?? "", row.private_body ?? "") !== row.commitment
        ) {
          return corrupt(
            row.seq,
            `Private part altered at seq ${row.seq}: it no longer matches its commitment`,
          );
        }
      } else if (!context.privateOmitted) {
        const erased = context.erasures.byEvent.get(row.id);
        if (!erased || erased.erasedBySeq <= row.seq) {
          return corrupt(
            row.seq,
            `The private part of seq ${row.seq} is missing and no recorded erasure names it`,
          );
        }
      }
    } else if (hasPrivate) {
      return corrupt(row.seq, `A private part at seq ${row.seq} has no commitment in the chain`);
    }

    prevHash = row.hash;
  }

  const erased: ErasedEventReport[] = [];
  for (const [id, e] of context.erasures.byEvent) {
    const seq = seqOf.get(id) ?? context.seqOfEvent?.(id);
    if (seq === undefined) continue;
    erased.push({
      seq,
      erasedBySeq: e.erasedBySeq,
      message: `erased at seq ${seq} by ledger/erased seq ${e.erasedBySeq}`,
    });
  }
  erased.sort((a, b) => a.seq - b.seq);
  return {
    valid: true,
    totalEvents,
    hashedEvents: rows.length,
    ...(erased.length > 0 ? { erased } : {}),
  };
}

/** Hash formula used before `payload_hash` existed (v1; rule 11). */
function legacyHash(row: ChainRow): string {
  return createHash("sha256")
    .update(`${row.prev_hash}:${row.seq}:${row.actor}:${row.type}:${row.payload}:${row.id}`)
    .digest("hex");
}

/** Append one entry to the erasure register (rule 35): ids and reasons only. */
export function appendErasureRegister(path: string, entry: ErasureRegisterEntry): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
}

/**
 * A run file an erasure may name (RUN-57): a relative path under
 * `.sekhemet/observations/` or `.sekhemet/transcripts/`, one level deep, no
 * `..`, never the ledger or an evidence bundle.
 */
export function isRunFilePath(path: string): boolean {
  return /^(observations|transcripts)\/[A-Za-z0-9._:-]+$/.test(path) && !path.includes("..");
}

function deleteRunFile(root: string, path: string): boolean {
  const target = join(root, path);
  if (!existsSync(target)) return false;
  rmSync(target, { force: true });
  return true;
}
