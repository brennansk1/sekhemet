import type { IncomingMessage, ServerResponse } from "node:http";
import type { CardRecord, CardStore } from "@sekhemet/kernel";
import { initials } from "@sekhemet/ui";

/**
 * Presence (teams item 26, NEW-teams-9; TEAM-26; dashboard DB-N9-20;
 * DESIGN_RESEARCH_COLLABORATION §4, Jira's who-is-here): the people viewing
 * an issue, a card someone is dragging, and who was active in the last five
 * minutes. It is light and never recorded: held in this process's memory
 * only, carried to the pages as `presence` frames on the live stream, and
 * nothing about it is ever written to the event log.
 *
 * Each open page (a *tab*) announces what it shows — `POST /api/presence
 * {tab, issue?, dragging?}` — when it opens an issue, starts or ends a
 * drag, leaves, and every 20 seconds while it stays; a tab that stops
 * announcing itself is forgotten after a minute.
 */

export interface PresenceOptions {
  /** How long a tab is kept without announcing itself. */
  ttlMs?: number;
  /** How long a person counts as active after their last announce (the green dot). */
  activeMs?: number;
  now?: () => number;
}

interface TabState {
  principal: string;
  issue?: string;
  dragging?: string;
  at: number;
}

export const PRESENCE_TTL_MS = 60_000;
export const ACTIVE_MS = 5 * 60_000;

export class Presence {
  private readonly tabs = new Map<string, TabState>();
  private readonly seen = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly activeMs: number;
  private readonly now: () => number;

  constructor(options: PresenceOptions = {}) {
    this.ttlMs = options.ttlMs ?? PRESENCE_TTL_MS;
    this.activeMs = options.activeMs ?? ACTIVE_MS;
    this.now = options.now ?? Date.now;
  }

  /** A tab says what it shows now; true when what others see changed. */
  public announce(
    principal: string,
    tab: string,
    state: { issue?: string | null | undefined; dragging?: string | null | undefined },
  ): boolean {
    const key = `${principal}|${tab}`;
    const before = this.tabs.get(key);
    const next: TabState = {
      principal,
      ...(state.issue ? { issue: state.issue } : {}),
      ...(state.dragging ? { dragging: state.dragging } : {}),
      at: this.now(),
    };
    this.seen.set(principal, next.at);
    if (!next.issue && !next.dragging) {
      this.tabs.delete(key);
      return before !== undefined;
    }
    this.tabs.set(key, next);
    return before?.issue !== next.issue || before?.dragging !== next.dragging;
  }

  /** Forget quiet tabs and inactive people; true when what others see changed. */
  public sweep(): boolean {
    const now = this.now();
    let changed = false;
    for (const [key, t] of this.tabs) {
      if (now - t.at > this.ttlMs) {
        this.tabs.delete(key);
        changed = true;
      }
    }
    for (const [p, at] of this.seen) if (now - at > this.activeMs) this.seen.delete(p);
    return changed;
  }

  /** The people viewing an issue, each once. */
  public viewers(issue: string): string[] {
    const out = new Set<string>();
    for (const t of this.tabs.values()) if (t.issue === issue) out.add(t.principal);
    return [...out];
  }

  /** Every issue someone views, with who. */
  public issues(): Record<string, string[]> {
    return this.group((t) => t.issue);
  }

  /** Every card being dragged, with who. */
  public dragging(): Record<string, string[]> {
    return this.group((t) => t.dragging);
  }

  private group(key: (t: TabState) => string | undefined): Record<string, string[]> {
    const out = new Map<string, Set<string>>();
    for (const t of this.tabs.values()) {
      const k = key(t);
      if (!k) continue;
      const people = out.get(k) ?? new Set<string>();
      people.add(t.principal);
      out.set(k, people);
    }
    return Object.fromEntries([...out].map(([k, v]) => [k, [...v]]));
  }

  /** People active in the last five minutes (the Members page's green dot). */
  public active(): string[] {
    const now = this.now();
    return [...this.seen].filter(([, at]) => now - at <= this.activeMs).map(([p]) => p);
  }
}

/** A person as an avatar: their principal, name and initials. */
export interface Face {
  principal: string;
  name: string;
  initials: string;
}

export interface PresenceRouteContext {
  presence: Presence;
  cardStore: CardStore | undefined;
  projectOf: (card: CardRecord) => string | undefined;
  nameOf: () => (principal: string | undefined) => string | undefined;
  json: (res: ServerResponse, status: number, body: unknown) => void;
  readJsonBody: (req: IncomingMessage) => Promise<Record<string, unknown>>;
  isTrustedMutation: (req: IncomingMessage) => boolean;
  principalOf: (req: IncomingMessage) => string;
  canSee: (req: IncomingMessage, project: string | undefined) => boolean;
  /** Something others see changed: push it to the streams. */
  changed: () => void;
}

const TAB = /^[A-Za-z0-9_-]{1,64}$/;

/** Faces for principals, sorted by name. */
export function faces(
  principals: readonly string[],
  nameOf: (principal: string | undefined) => string | undefined,
): Face[] {
  return principals
    .map((principal) => {
      const name = nameOf(principal) ?? "A person";
      return { principal, name, initials: initials(name) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * What one reader's stream is told: every issue viewed and card dragged
 * that the reader can see, by face. The reader is included; the page
 * leaves itself out.
 */
export async function presenceFrame(
  presence: Presence,
  canSeeCard: (cardId: string) => Promise<boolean>,
  nameOf: (principal: string | undefined) => string | undefined,
): Promise<{ issues: Record<string, Face[]>; dragging: Record<string, Face[]> }> {
  const pick = async (m: Record<string, string[]>) => {
    const out: Record<string, Face[]> = {};
    for (const [id, who] of Object.entries(m))
      if (await canSeeCard(id)) out[id] = faces(who, nameOf);
    return out;
  };
  return { issues: await pick(presence.issues()), dragging: await pick(presence.dragging()) };
}

/** `GET /api/presence?issue=` and `POST /api/presence` (teams §3). */
export async function handlePresenceRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  query: URLSearchParams,
  ctx: PresenceRouteContext,
): Promise<boolean> {
  if (url !== "/api/presence") return false;
  const method = req.method ?? "GET";
  const nameOf = ctx.nameOf();
  const visible = async (id: string | null | undefined): Promise<boolean | undefined> => {
    if (!id) return undefined;
    const card = ctx.cardStore ? await ctx.cardStore.getCard(id) : undefined;
    return card ? ctx.canSee(req, ctx.projectOf(card)) : false;
  };
  if (method === "GET") {
    const issue = query.get("issue");
    const sees = await visible(issue);
    if (sees === false) {
      ctx.json(res, 404, { error: `No issue ${issue}` });
      return true;
    }
    ctx.json(res, 200, {
      viewers: issue ? faces(ctx.presence.viewers(issue), nameOf) : [],
      active: ctx.presence.active(),
    });
    return true;
  }
  if (method !== "POST") {
    ctx.json(res, 405, { error: "Method not allowed." });
    return true;
  }
  if (!ctx.isTrustedMutation(req)) {
    ctx.json(res, 403, { error: "Actions must come from the dashboard itself" });
    return true;
  }
  const body = await ctx.readJsonBody(req).catch(() => ({}) as Record<string, unknown>);
  const tab = typeof body.tab === "string" ? body.tab : "";
  if (!TAB.test(tab)) {
    ctx.json(res, 400, { error: "tab is the page's own id: letters, digits, - and _" });
    return true;
  }
  const str = (v: unknown): string | null | undefined =>
    typeof v === "string" && v ? v : v === null ? null : undefined;
  const issue = str(body.issue);
  const dragging = str(body.dragging);
  for (const id of [issue, dragging]) {
    if ((await visible(id)) === false) {
      ctx.json(res, 404, { error: `No issue ${id}` });
      return true;
    }
  }
  if (ctx.presence.announce(ctx.principalOf(req), tab, { issue, dragging })) ctx.changed();
  ctx.json(res, 200, { viewers: issue ? faces(ctx.presence.viewers(issue), nameOf) : [] });
  return true;
}
