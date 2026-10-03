import type { BoardService } from "@sekhemet/board";
import type { CardRecord, CardStore, EventLog } from "@sekhemet/kernel";
import { type IntakeFacts, type TriageDecision, shortId } from "@sekhemet/ui";
import { markDuplicate } from "../pm/apply.js";
import { reject } from "../triage.js";
import type { Access } from "./access.js";
import { NO_ACCESS } from "./settings.js";

/**
 * Intake and triage (dashboard §2.4.19, NEW-dashboard-10; DB-N10-1..4;
 * FINDINGS PRC-01; DEC-51). Nothing here is a store of its own: whether an
 * issue waits in Triage is a fold of the ledger.
 *
 * A Backlog issue waits in Triage when it was filed — its `card/created` —
 * by a person whose level on its project is below Member (a Stakeholder or
 * a Viewer; the level read now, and a removed person's last level), by an
 * integration (the tracker's sync), or by an import (`card/imported`), and
 * no Member has triaged it since. A Member's decision is `issue/triaged
 * {decision}` with their principal: *Accept into Backlog* leaves the issue
 * in Backlog and records no `card/accepted`; *Decline* moves it to Won't do
 * with the reason; *Duplicate of* moves it to Won't do with the link; and
 * *Snooze* hides it until a time, after which it waits again. Solo has no
 * Triage: one person files everything. No new state and no new permission.
 */

export const TRIAGED = "issue/triaged";
const IMPORTED = "card/imported";
const CREATED = "card/created";

/** The ledger's actors that file issues on a person's behalf. */
const PERSON_ACTORS = new Set(["human", "mcp"]);
/** The trackers' sync, by actor, and the name a row says. */
const INTEGRATIONS: Record<string, string> = { github: "GitHub", forgejo: "Forgejo", sync: "" };

export interface IntakeDeps {
  log: EventLog;
  cardStore: CardStore;
  access: Access;
  projectOf: (card: CardRecord) => string | undefined;
}

export class TriageError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "TriageError";
  }
}

interface Filed {
  seq: number;
  at: string;
  actor: string;
  principal?: string;
  imported?: boolean;
  /** The latest decision, with its seq. */
  triaged?: { decision: TriageDecision; until?: string; seq: number };
}

interface FoldState {
  lastSeq: number;
  filed: Map<string, Filed>;
}
const cache = new WeakMap<EventLog, FoldState>();
const PAGE = 5_000;

/** The fold of who filed each issue and its latest triage, advanced over new events only. */
async function foldIntake(log: EventLog): Promise<FoldState> {
  const state = cache.get(log) ?? { lastSeq: 0, filed: new Map<string, Filed>() };
  for (;;) {
    const events = await log.getEventsByTypes(
      [CREATED, IMPORTED, TRIAGED],
      state.lastSeq + 1,
      PAGE,
    );
    for (const e of events) {
      state.lastSeq = Math.max(state.lastSeq, e.seq);
      const p = e.payload as { id?: string; cardId?: string; decision?: string; until?: string };
      const cardId = e.cardId ?? p.cardId ?? p.id;
      if (!cardId) continue;
      if (e.type === CREATED) {
        state.filed.set(cardId, {
          seq: e.seq,
          at: e.createdAt,
          actor: e.actor,
          ...(e.principal ? { principal: e.principal } : {}),
        });
        continue;
      }
      const f = state.filed.get(cardId);
      if (!f) continue;
      if (e.type === IMPORTED) f.imported = true;
      else if (e.type === TRIAGED) {
        f.triaged = {
          decision: p.decision as TriageDecision,
          ...(p.until ? { until: p.until } : {}),
          seq: e.seq,
        };
      }
    }
    if (events.length < PAGE) break;
  }
  cache.set(log, state);
  return state;
}

/** The filer's level on the project: the override there first, and a removed person's last level. */
function filerLevel(access: Access, principal: string, project: string | undefined) {
  const m = access.projection().members.get(principal);
  if (!m) return undefined;
  const own = project ? m.projects[project] : undefined;
  return own && own !== NO_ACCESS ? own : m.level;
}

/** Where an issue came from, when it is one Triage takes. */
function sourceOf(
  deps: IntakeDeps,
  f: Filed,
  project: string | undefined,
  nameOf: (principal: string) => string | undefined,
): Omit<IntakeFacts, "at"> | undefined {
  if (f.imported) return { from: "import" };
  if (f.actor in INTEGRATIONS) {
    const by = INTEGRATIONS[f.actor];
    return { from: "integration", ...(by ? { by } : {}) };
  }
  if (!PERSON_ACTORS.has(f.actor) || !f.principal) return undefined;
  const level = filerLevel(deps.access, f.principal, project);
  if (level !== "stakeholder" && level !== "viewer") return undefined;
  const by = nameOf(f.principal);
  return { from: level, ...(by ? { by } : {}) };
}

/** An untriaged issue: what the board shows on it, its project and the seq that filed it. */
export interface Untriaged extends IntakeFacts {
  project?: string;
  seq: number;
}

/**
 * The issues waiting in Triage (DB-N10-2), by id: Backlog issues filed below
 * Member, by an integration or an import, not triaged since, or snoozed
 * until a time now past. Empty in Solo.
 */
export async function untriagedIssues(
  deps: IntakeDeps,
  options: {
    cards?: readonly CardRecord[];
    now?: number;
    nameOf?: (principal: string) => string | undefined;
  } = {},
): Promise<Map<string, Untriaged>> {
  const out = new Map<string, Untriaged>();
  if (deps.access.setup !== "team") return out;
  const now = options.now ?? Date.now();
  const nameOf = options.nameOf ?? (() => undefined);
  const { filed } = await foldIntake(deps.log);
  const cards = options.cards ?? (await deps.cardStore.listCards({ status: "backlog" }));
  for (const card of cards) {
    if (card.status !== "backlog") continue;
    const f = filed.get(card.id);
    if (!f) continue;
    const t = f.triaged;
    if (t && (t.decision !== "snooze" || !t.until || Date.parse(t.until) > now)) continue;
    const project = deps.projectOf(card);
    const source = sourceOf(deps, f, project, nameOf);
    if (!source) continue;
    out.set(card.id, {
      ...source,
      at: f.at,
      seq: Math.max(f.seq, t?.seq ?? 0),
      ...(project ? { project } : {}),
    });
  }
  return out;
}

const DECISIONS = new Set<TriageDecision>(["accept", "decline", "duplicate", "snooze"]);

/**
 * A Member's triage decision (DB-N10-3): checked against the issue's place
 * in Triage, applied, then recorded as `issue/triaged` with the person's
 * principal. The server's access check has already required a Member's
 * `issue.edit` on the issue's project.
 */
export async function triageIssue(
  deps: IntakeDeps & { boardService: BoardService; repoPath: string },
  input: {
    cardId: string;
    principal: string;
    decision: unknown;
    reason?: unknown;
    duplicateOf?: unknown;
    until?: unknown;
    now?: number;
  },
): Promise<{ decision: TriageDecision; card: CardRecord }> {
  const decision = input.decision as TriageDecision;
  if (!DECISIONS.has(decision)) {
    throw new TriageError("Choose Accept into Backlog, Decline, Duplicate of or Snooze.", 400);
  }
  const card = await deps.cardStore.getCard(input.cardId);
  if (!card) throw new TriageError(`No issue ${input.cardId}`, 404);
  const waiting = await untriagedIssues(deps, {
    cards: [card],
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  if (!waiting.has(card.id)) {
    throw new TriageError(`${shortId(card.id)} is not waiting in Triage.`, 409);
  }
  const now = input.now ?? Date.now();
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 2000) : "";
  const of = typeof input.duplicateOf === "string" ? input.duplicateOf.trim() : "";
  const until = typeof input.until === "string" ? input.until : "";
  const ctx = {
    repoPath: deps.repoPath,
    cardStore: deps.cardStore,
    boardService: deps.boardService as never,
    log: deps.log,
    principal: input.principal,
  };
  const payload: Record<string, unknown> = { cardId: card.id, decision };
  switch (decision) {
    case "accept":
      break;
    case "decline":
      if (!reason) throw new TriageError("Say why it is declined.", 400);
      await reject(ctx, card, reason);
      break;
    case "duplicate": {
      if (!of || of === card.id) throw new TriageError("Choose the issue it duplicates.", 400);
      const original = await deps.cardStore.getCard(of);
      if (!original || deps.projectOf(original) !== deps.projectOf(card)) {
        throw new TriageError(`No issue ${of} in this project.`, 400);
      }
      await markDuplicate(ctx, card, of, "human");
      payload.duplicateOf = of;
      break;
    }
    case "snooze": {
      const at = Date.parse(until);
      if (!until || Number.isNaN(at) || at <= now) {
        throw new TriageError("Snooze needs a time to bring it back.", 400);
      }
      payload.until = new Date(at).toISOString();
      break;
    }
  }
  await deps.log.append({
    actor: "human",
    type: TRIAGED,
    cardId: card.id,
    principal: input.principal,
    payload,
    ...(decision === "decline" ? { private: { reason } } : {}),
  });
  return { decision, card: (await deps.cardStore.getCard(card.id)) ?? card };
}

/**
 * The project lead's Triage counts (DB-N10-4): one per project they lead and
 * can see, with the oldest waiting issue's time and the latest seq that
 * changed what waits there, so a new issue brings a marked-done row back.
 */
export async function triageCountsFor(
  deps: IntakeDeps,
  me: string,
  canSee: (project: string | undefined) => boolean,
): Promise<{ project: string; count: number; at: string; seq: number }[]> {
  if (deps.access.setup !== "team") return [];
  const led = deps.cardStore
    .listProjects()
    .filter((p) => deps.access.settings(p.id).lead === me && canSee(p.id))
    .map((p) => p.id);
  if (led.length === 0) return [];
  const waiting = await untriagedIssues(deps);
  return led.flatMap((project) => {
    const rows = [...waiting.values()].filter((u) => u.project === project);
    if (rows.length === 0) return [];
    return [
      {
        project,
        count: rows.length,
        at: rows.reduce((a, r) => (r.at < a ? r.at : a), rows[0]?.at ?? ""),
        seq: rows.reduce((a, r) => Math.max(a, r.seq), 0),
      },
    ];
  });
}
