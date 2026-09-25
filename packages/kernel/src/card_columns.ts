import { CARD_CHANGES, CARD_KINDS, CARD_SPLITS, deriveCardKind, spidrSplit } from "./card_class.js";
import { DEFAULT_STEP_BUDGET } from "./stop_reasons.js";

/**
 * The one card column table (kernel rule 38, K-N4-4): each card field is
 * declared here once, and the `cards` DDL, the insert and the replay
 * projection of a `card/created` payload are derived from it. Adding a
 * column is one entry here (and, for databases already on disk, a numbered
 * migration that adds it: `addColumnMigration` in schema.ts).
 */

export type CardSqlValue = string | number | null;

export interface CardColumnContext {
  /** A generated order key, for a payload written before `order_key` existed. */
  orderKey: () => string;
}

export interface CardColumn {
  column: string;
  /** The column's definition in `CREATE TABLE` (and `ALTER TABLE ADD COLUMN` when it allows). */
  ddl: string;
  /** Its value from a `card/created` payload, as the replay projection stores it. */
  fromPayload: (payload: Record<string, unknown>, ctx: CardColumnContext) => CardSqlValue;
  /**
   * The `CardUpdate` field a `card/updated` patch writes it from, with the
   * same `fromPayload` encoding; absent for a column no patch may write
   * (`id`, `tier`, `parent_id`, `status` — only the transition law writes
   * a status — and the timestamps).
   */
  patchKey?: string;
}

const CARD_STATUS_CHECK =
  "status IN ('backlog','ready','planning','in_progress','verify','review','done','rejected','parked')";

const sqlList = (values: readonly string[]) => values.map((v) => `'${v}'`).join(",");
const jsonOrNull = (key: string) => (p: Record<string, unknown>) =>
  p[key] === undefined || p[key] === null ? null : JSON.stringify(p[key]);

const text = (key: string) => (p: Record<string, unknown>) => (p[key] as string) ?? null;
const num =
  (key: string, fallback: number | null = null) =>
  (p: Record<string, unknown>) =>
    (p[key] as number) ?? fallback;
const json = (key: string) => (p: Record<string, unknown>) => JSON.stringify(p[key] ?? []);
const route = (p: Record<string, unknown>) =>
  (p.modelRoute ?? null) as { planner?: string; executor?: string } | null;

export const CARD_COLUMN_TABLE = [
  { column: "id", ddl: "id TEXT PRIMARY KEY", fromPayload: (p) => p.id as string },
  {
    column: "tier",
    ddl: "tier TEXT NOT NULL CHECK(tier IN ('initiative','epic','feature','story','task'))",
    fromPayload: (p) => p.tier as string,
  },
  {
    column: "parent_id",
    ddl: "parent_id TEXT REFERENCES cards(id)",
    fromPayload: text("parentId"),
  },
  {
    column: "title",
    ddl: "title TEXT NOT NULL",
    fromPayload: (p) => p.title as string,
    patchKey: "title",
  },
  {
    column: "status",
    ddl: `status TEXT NOT NULL CHECK(${CARD_STATUS_CHECK})`,
    fromPayload: (p) => p.status as string,
  },
  {
    column: "scope_files",
    ddl: "scope_files JSON NOT NULL DEFAULT '[]'",
    fromPayload: json("scopeFiles"),
    patchKey: "scopeFiles",
  },
  {
    column: "step_budget",
    ddl: `step_budget INTEGER NOT NULL DEFAULT ${DEFAULT_STEP_BUDGET}`,
    fromPayload: num("stepBudget", DEFAULT_STEP_BUDGET),
    patchKey: "stepBudget",
  },
  {
    column: "steps_used",
    ddl: "steps_used INTEGER NOT NULL DEFAULT 0",
    fromPayload: num("stepsUsed", 0),
    patchKey: "stepsUsed",
  },
  { column: "spec", ddl: "spec TEXT", fromPayload: text("spec"), patchKey: "spec" },
  {
    column: "acceptance_criteria",
    ddl: "acceptance_criteria JSON NOT NULL DEFAULT '[]'",
    fromPayload: json("acceptanceCriteria"),
    patchKey: "acceptanceCriteria",
  },
  {
    column: "acceptance_tests",
    ddl: "acceptance_tests JSON NOT NULL DEFAULT '[]'",
    fromPayload: json("acceptanceTests"),
    patchKey: "acceptanceTests",
  },
  {
    column: "difficulty",
    ddl: "difficulty INTEGER CHECK(difficulty IS NULL OR (difficulty >= 1 AND difficulty <= 10))",
    fromPayload: num("difficulty"),
    patchKey: "difficulty",
  },
  {
    column: "token_budget",
    ddl: "token_budget INTEGER",
    fromPayload: num("tokenBudget"),
    patchKey: "tokenBudget",
  },
  {
    column: "seconds_budget",
    ddl: "seconds_budget INTEGER",
    fromPayload: num("secondsBudget"),
    patchKey: "secondsBudget",
  },
  {
    column: "tokens_used",
    ddl: "tokens_used INTEGER NOT NULL DEFAULT 0",
    fromPayload: num("tokensUsed", 0),
    patchKey: "tokensUsed",
  },
  {
    column: "seconds_used",
    ddl: "seconds_used INTEGER NOT NULL DEFAULT 0",
    fromPayload: num("secondsUsed", 0),
    patchKey: "secondsUsed",
  },
  {
    column: "model_route_planner",
    ddl: "model_route_planner TEXT",
    fromPayload: (p) => route(p)?.planner ?? null,
    patchKey: "modelRoute",
  },
  {
    column: "model_route_executor",
    ddl: "model_route_executor TEXT",
    fromPayload: (p) => route(p)?.executor ?? null,
    patchKey: "modelRoute",
  },
  {
    column: "depends_on",
    ddl: "depends_on JSON NOT NULL DEFAULT '[]'",
    fromPayload: json("dependsOn"),
    patchKey: "dependsOn",
  },
  {
    column: "context_pack_id",
    ddl: "context_pack_id TEXT",
    fromPayload: text("contextPackId"),
    patchKey: "contextPackId",
  },
  {
    column: "evidence_id",
    ddl: "evidence_id TEXT",
    fromPayload: text("evidenceId"),
    patchKey: "evidenceId",
  },
  {
    column: "external_ref",
    ddl: "external_ref JSON",
    fromPayload: (p) => (p.externalRef ? JSON.stringify(p.externalRef) : null),
    patchKey: "externalRef",
  },
  {
    column: "stop_reason",
    ddl: "stop_reason TEXT",
    fromPayload: text("stopReason"),
    patchKey: "stopReason",
  },
  {
    column: "priority",
    ddl: "priority REAL NOT NULL DEFAULT 0.0",
    fromPayload: num("priority", 0),
    patchKey: "priority",
  },
  {
    column: "order_key",
    ddl: "order_key TEXT NOT NULL DEFAULT ''",
    // Events written before `order_key` existed carry no key; give those a
    // generated one so replaying an old log still yields an ordered board.
    fromPayload: (p, ctx) => (p.orderKey as string) ?? ctx.orderKey(),
    patchKey: "orderKey",
  },
  {
    column: "blocked_reason",
    ddl: "blocked_reason TEXT",
    fromPayload: text("blockedReason"),
    patchKey: "blockedReason",
  },
  // Team practice fields (PM_CONTRACT §2): Linear/Jira/GitHub vocabulary.
  { column: "estimate", ddl: "estimate REAL", fromPayload: num("estimate"), patchKey: "estimate" },
  {
    column: "labels",
    ddl: "labels JSON NOT NULL DEFAULT '[]'",
    fromPayload: json("labels"),
    patchKey: "labels",
  },
  { column: "epic_id", ddl: "epic_id TEXT", fromPayload: text("epicId"), patchKey: "epicId" },
  { column: "cycle_id", ddl: "cycle_id TEXT", fromPayload: text("cycleId"), patchKey: "cycleId" },
  { column: "assignee", ddl: "assignee TEXT", fromPayload: text("assignee"), patchKey: "assignee" },
  { column: "due_date", ddl: "due_date TEXT", fromPayload: text("dueDate"), patchKey: "dueDate" },
  {
    column: "project_id",
    ddl: "project_id TEXT",
    fromPayload: text("projectId"),
    patchKey: "projectId",
  },
  // NEW-kernel-9: the kind is stored once, at creation; a `card/created`
  // written before it was stored is given the kind its own payload derives,
  // so replay and the migration agree and nothing re-derives it later.
  {
    column: "kind",
    ddl: `kind TEXT NOT NULL DEFAULT 'implement' CHECK(kind IN (${sqlList(CARD_KINDS)}))`,
    fromPayload: (p) =>
      (p.kind as string | undefined) ??
      deriveCardKind({
        title: String(p.title ?? ""),
        labels: (p.labels as string[] | undefined) ?? [],
        scopeFiles: (p.scopeFiles as string[] | undefined) ?? [],
      }),
    patchKey: "kind",
  },
  {
    column: "change",
    ddl: `change TEXT NOT NULL DEFAULT 'feature' CHECK(change IN (${sqlList(CARD_CHANGES)}))`,
    fromPayload: (p) => (p.change as string | undefined) ?? "feature",
    patchKey: "change",
  },
  {
    column: "split",
    ddl: `split TEXT CHECK(split IS NULL OR split IN (${sqlList(CARD_SPLITS)}))`,
    fromPayload: (p) =>
      "split" in p
        ? ((p.split as string | null) ?? null)
        : (spidrSplit(String(p.title ?? "")) ?? null),
  },
  // NEW-kernel-6: who is on the card. Owner and delegate change only by
  // their own events (`card/owner_changed`, `card/delegated`); the accepter
  // is set by the accepting move.
  { column: "owner", ddl: "owner TEXT", fromPayload: text("owner") },
  { column: "delegate", ddl: "delegate JSON", fromPayload: jsonOrNull("delegate") },
  { column: "accepter", ddl: "accepter TEXT", fromPayload: text("accepter") },
  // NEW-kernel-3: a typed hold, set and cleared by its own events.
  { column: "hold", ddl: "hold JSON", fromPayload: jsonOrNull("hold") },
  {
    column: "created_at",
    ddl: "created_at TEXT NOT NULL",
    fromPayload: (p) => p.createdAt as string,
  },
  {
    column: "updated_at",
    ddl: "updated_at TEXT NOT NULL",
    fromPayload: (p) => p.updatedAt as string,
  },
] as const satisfies readonly CardColumn[];

/** A column of the `cards` table, by name. */
export type CardColumnName = (typeof CARD_COLUMN_TABLE)[number]["column"];

/** A `cards` row as SQLite returns it, typed from the table. */
export type CardRow = { [K in CardColumnName]: CardSqlValue };

/** The body of `CREATE TABLE cards (...)`, from the table. */
export function cardsTableDdl(table: readonly CardColumn[] = CARD_COLUMN_TABLE): string {
  return table.map((c) => `  ${c.ddl}`).join(",\n");
}

/** The column list, from the table. */
export function cardColumnList(table: readonly CardColumn[] = CARD_COLUMN_TABLE): string {
  return table.map((c) => c.column).join(", ");
}

/** The replay projection's insert of a created card, from the table. */
export function cardInsertSql(table: readonly CardColumn[] = CARD_COLUMN_TABLE): string {
  return `INSERT OR REPLACE INTO cards (${cardColumnList(table)}) VALUES (${table.map(() => "?").join(", ")})`;
}

/** The insert's values for a `card/created` payload, in the table's order. */
export function cardInsertValues(
  table: readonly CardColumn[],
  payload: Record<string, unknown>,
  ctx: CardColumnContext,
): CardSqlValue[] {
  return table.map((c) => c.fromPayload(payload, ctx));
}

/**
 * The `SET` assignments a `card/updated` patch makes, from the table: every
 * column whose `patchKey` the patch carries, encoded as `fromPayload` does.
 */
export function cardPatchAssignments(
  patch: Record<string, unknown>,
  table: readonly CardColumn[] = CARD_COLUMN_TABLE,
): Array<[column: string, value: CardSqlValue]> {
  const out: Array<[string, CardSqlValue]> = [];
  for (const c of table) {
    if (c.patchKey === undefined || patch[c.patchKey] === undefined) continue;
    out.push([c.column, c.fromPayload(patch, { orderKey: () => "" })]);
  }
  return out;
}
