import type { ExternalRef } from "@sekhemet/kernel";
import type { FetchLike, GitHubClient } from "./github_app.js";

/**
 * The tracker adapter (integrations items 7–9) and its GitHub and Forgejo
 * implementations. The board owns card state, gate results and budgets; the
 * tracker owns what people write — title, description, assignee, labels.
 * A field both sides can change merges three ways against the snapshot of
 * the last sync (item 4, `mergeThreeWay`).
 */
export interface ExternalItem {
  ref: ExternalRef;
  title: string;
  /** The description, without the card marker the board writes. */
  body: string;
  /** The tracker's labels, without the delegate label (`DELEGATE_LABEL`). */
  labels: string[];
  /** The tracker's user login for the assignee: a person, never the Worker. */
  assignee?: string;
  /** The delegate label is on the item: the Worker builds it (NEW-integrations-2). */
  delegatedToWorker?: boolean;
  state: "open" | "closed";
  updatedAt: string;
  /** Parent issue, when the tracker has hierarchy. */
  parent?: string;
}

export interface SyncCard {
  id: string;
  title: string;
  spec?: string;
  labels?: string[];
  /** The owner's login on this tracker (INT-36); present but undefined unassigns. */
  owner?: string | undefined;
  /** Who builds it: the Worker is written as a label, never as a user (INT-36). */
  delegate?: "worker";
  status: string;
  updatedAt: string;
  externalRef?: ExternalRef;
}

export interface SyncCapabilities {
  hierarchy: boolean;
  dependencies: boolean;
  webhooks: boolean;
  maxDepth: number;
}

export interface SyncAdapter {
  readonly system: ExternalRef["system"];
  readonly capabilities: SyncCapabilities;
  pull(since: string): Promise<ExternalItem[]>;
  push(card: SyncCard): Promise<ExternalRef>;
  update(ref: ExternalRef, patch: Partial<SyncCard>): Promise<void>;
}

/**
 * The label that says the Worker is the card's delegate, on a tracker with no
 * agent field (GitHub, Forgejo): the delegate is shown there, the assignee
 * stays a person (integrations item 6, INT-36).
 */
export const DELEGATE_LABEL = "delegate:sekhemet-worker";

/** One GitHub issue's one identity on every path: `owner/repo#n` (item 8, INT-1). */
export function githubIssueId(repo: { owner: string; repo: string } | string, n: number): string {
  const name = typeof repo === "string" ? repo : `${repo.owner}/${repo.repo}`;
  return `${name}#${n}`;
}

/** The issue number of a tracker id: `owner/repo#n`, or a legacy bare `n`. */
export function issueNumberOf(id: string): number {
  const m = /(?:^|#)(\d+)$/.exec(id);
  if (!m) throw new Error(`Not an issue id: ${id}`);
  return Number(m[1]);
}

/** The fields both the board and the tracker may change (item 4). */
export interface SharedFields {
  title: string;
  body: string;
  labels: string[];
  assignee?: string | undefined;
}

export interface FieldConflict {
  field: string;
  kept: unknown;
  lost: unknown;
  winner: "board" | "tracker";
  at: string;
}

const SHARED: (keyof SharedFields)[] = ["title", "body", "labels", "assignee"];
const norm = (field: keyof SharedFields, v: unknown) =>
  JSON.stringify(field === "labels" ? [...((v as string[]) ?? [])].sort() : (v ?? null));

/**
 * The three-way merge of a shared field set (integrations item 4, INT-4…6):
 * against `base`, the snapshot both sides agreed at the last sync, a field
 * only the tracker changed goes to the board, a field only the board changed
 * goes to the tracker, and only a field both changed is a true conflict —
 * there the newer side wins and the other value is kept in the history.
 * With no snapshot (a first link), a difference is resolved as a conflict.
 */
export function mergeThreeWay(
  base: SharedFields | undefined,
  board: SharedFields & { updatedAt: string },
  tracker: SharedFields & { updatedAt: string },
): {
  toBoard: Partial<SharedFields>;
  toTracker: Partial<SharedFields>;
  merged: SharedFields;
  history: FieldConflict[];
} {
  const toBoard: Partial<SharedFields> = {};
  const toTracker: Partial<SharedFields> = {};
  const merged: SharedFields = { ...board };
  const history: FieldConflict[] = [];
  const trackerNewer = Date.parse(tracker.updatedAt) > Date.parse(board.updatedAt);
  const set = (o: Partial<SharedFields>, f: keyof SharedFields, v: unknown) => {
    (o as Record<string, unknown>)[f] = v;
  };
  for (const f of SHARED) {
    if (norm(f, board[f]) === norm(f, tracker[f])) continue;
    const boardChanged = !base || norm(f, board[f]) !== norm(f, base[f]);
    const trackerChanged = !base || norm(f, tracker[f]) !== norm(f, base[f]);
    let winner: "board" | "tracker";
    if (trackerChanged && !boardChanged) winner = "tracker";
    else if (boardChanged && !trackerChanged) winner = "board";
    else {
      winner = trackerNewer ? "tracker" : "board";
      history.push({
        field: f,
        kept: winner === "tracker" ? tracker[f] : board[f],
        lost: winner === "tracker" ? board[f] : tracker[f],
        winner,
        at: winner === "tracker" ? tracker.updatedAt : board.updatedAt,
      });
    }
    if (winner === "tracker") {
      set(toBoard, f, tracker[f]);
      set(merged, f, tracker[f]);
    } else set(toTracker, f, board[f]);
  }
  return { toBoard, toTracker, merged, history };
}

const MARKER = /\n*<!-- sekhemet:card=[^>]*-->\s*$/;

function cardBody(card: Pick<SyncCard, "id" | "spec">): string {
  return `${card.spec ?? ""}\n\n<!-- sekhemet:card=${card.id} -->`.trim();
}

/** A tracker's labels without the delegate label, and whether it was there. */
function splitLabels(names: string[]): { labels: string[]; delegatedToWorker: boolean } {
  return {
    labels: names.filter((l) => l !== DELEGATE_LABEL),
    delegatedToWorker: names.includes(DELEGATE_LABEL),
  };
}

/** The labels a card is written with: its own, plus the delegate label for the Worker. */
function labelsFor(card: Partial<SyncCard>): string[] | undefined {
  if (card.labels === undefined && card.delegate === undefined) return undefined;
  const own = (card.labels ?? []).filter((l) => l !== DELEGATE_LABEL);
  return card.delegate === "worker" ? [...own, DELEGATE_LABEL] : own;
}

interface RestIssue {
  number: number;
  html_url: string;
  title: string;
  body: string | null;
  labels: { name: string }[];
  assignee: { login: string } | null;
  state: string;
  updated_at: string;
  pull_request?: unknown;
}

/** GitHub Issues through the one client (REST, paginated), `gh`'s login or the App's. */
export class GitHubIssuesAdapter implements SyncAdapter {
  public readonly system = "github" as const;
  public readonly capabilities: SyncCapabilities = {
    hierarchy: true,
    dependencies: false,
    webhooks: true,
    maxDepth: 2,
  };
  /** Over the one client, whose `fetch` is the caller's network policy (security item 33). */
  constructor(
    private readonly repo: { owner: string; repo: string },
    private readonly client: GitHubClient,
  ) {}

  private get base(): string {
    return `/repos/${this.repo.owner}/${this.repo.repo}`;
  }

  /** Every issue updated since `since`, every page (INT-2); pull requests left out. */
  public async pull(since: string): Promise<ExternalItem[]> {
    const items = await this.client.restPages<RestIssue>(
      `${this.base}/issues?state=all&per_page=100&since=${encodeURIComponent(since)}`,
    );
    return items
      .filter((i) => !i.pull_request)
      .map((i) => ({
        ref: { system: "github", id: githubIssueId(this.repo, i.number), url: i.html_url },
        title: i.title,
        body: (i.body ?? "").replace(MARKER, ""),
        ...splitLabels(i.labels.map((l) => l.name)),
        ...(i.assignee ? { assignee: i.assignee.login } : {}),
        state: i.state === "closed" ? "closed" : "open",
        updatedAt: i.updated_at,
      }));
  }

  public async push(card: SyncCard): Promise<ExternalRef> {
    if (card.externalRef) {
      await this.update(card.externalRef, card);
      return card.externalRef;
    }
    const issue = await this.client.rest<{ number: number; html_url: string }>(
      "POST",
      `${this.base}/issues`,
      {
        title: card.title,
        body: cardBody(card),
        labels: labelsFor(card) ?? [],
        ...(card.owner ? { assignees: [card.owner] } : {}),
      },
    );
    return { system: "github", id: githubIssueId(this.repo, issue.number), url: issue.html_url };
  }

  public async update(ref: ExternalRef, patch: Partial<SyncCard>): Promise<void> {
    const labels = labelsFor(patch);
    await this.client.rest("PATCH", `${this.base}/issues/${issueNumberOf(ref.id)}`, {
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.spec !== undefined
        ? { body: cardBody({ id: patch.id ?? "", spec: patch.spec }) }
        : {}),
      ...(labels !== undefined ? { labels } : {}),
      ...("owner" in patch ? { assignees: patch.owner ? [patch.owner] : [] } : {}),
      ...(patch.status === "done" ? { state: "closed" } : {}),
    });
  }
}

/** Forgejo / Gitea issues (Y11): the Gitea-compatible REST API, token auth. */
export class ForgejoIssuesAdapter implements SyncAdapter {
  public readonly system = "forgejo" as const;
  public readonly capabilities: SyncCapabilities = {
    hierarchy: false,
    dependencies: true,
    webhooks: true,
    maxDepth: 1,
  };

  constructor(
    private readonly baseUrl: string,
    private readonly repo: { owner: string; repo: string },
    private readonly token: string,
    /** The caller's network policy: every request is decided and recorded (security item 33). */
    private readonly fetch: FetchLike,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetch(`${this.baseUrl.replace(/\/+$/, "")}/api/v1${path}`, {
      method,
      headers: {
        Authorization: `token ${this.token}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok)
      throw new Error(`Forgejo ${method} ${path} failed (${res.status}): ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  public async pull(since: string): Promise<ExternalItem[]> {
    const items = await this.call<
      {
        number: number;
        html_url: string;
        title: string;
        body: string;
        labels: { name: string }[];
        assignee: { login: string } | null;
        state: string;
        updated_at: string;
      }[]
    >(
      "GET",
      `/repos/${this.repo.owner}/${this.repo.repo}/issues?type=issues&state=all&since=${encodeURIComponent(since)}`,
    );
    return items.map((i) => ({
      ref: { system: "forgejo", id: String(i.number), url: i.html_url },
      title: i.title,
      body: (i.body ?? "").replace(MARKER, ""),
      ...splitLabels((i.labels ?? []).map((l) => l.name)),
      ...(i.assignee ? { assignee: i.assignee.login } : {}),
      state: i.state === "closed" ? "closed" : "open",
      updatedAt: i.updated_at,
    }));
  }

  public async push(card: SyncCard): Promise<ExternalRef> {
    if (card.externalRef) {
      await this.update(card.externalRef, card);
      return card.externalRef;
    }
    const issue = await this.call<{ number: number; html_url: string }>(
      "POST",
      `/repos/${this.repo.owner}/${this.repo.repo}/issues`,
      { title: card.title, body: cardBody(card) },
    );
    return { system: "forgejo", id: String(issue.number), url: issue.html_url };
  }

  public async update(ref: ExternalRef, patch: Partial<SyncCard>): Promise<void> {
    await this.call("PATCH", `/repos/${this.repo.owner}/${this.repo.repo}/issues/${ref.id}`, {
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.spec !== undefined
        ? { body: cardBody({ ...(patch as SyncCard), id: patch.id ?? "" }) }
        : {}),
      ...(patch.status === "done" ? { state: "closed" } : {}),
    });
  }

  /** Forgejo has native issue dependencies: record a card's dependency edge. */
  public async addDependency(ref: ExternalRef, dependsOn: ExternalRef): Promise<void> {
    await this.call(
      "POST",
      `/repos/${this.repo.owner}/${this.repo.repo}/issues/${ref.id}/dependencies`,
      {
        owner: this.repo.owner,
        repo: this.repo.repo,
        index: Number(dependsOn.id),
      },
    );
  }
}

// ----------------------------------------------------------- Y20 reconciliation

export type ReconcileAction =
  | { action: "none" }
  | { action: "apply_on_completion"; fields: string[] }
  | { action: "replan_on_completion"; fields: string[]; change: "scope" | "criteria" };

/**
 * An issue edited externally while its card is running (integrations item
 * 5, DEC-25 R6): edits to non-scope fields are applied when the card
 * completes; a change to the scope or the acceptance criteria is recorded
 * and, at the card's end, sends it to Planning instead of Review (INT-11a).
 * The Worker is never paused for it. *Changed from Y20's pause-and-ask.*
 */
export function reconcileExternalEdit(
  card: {
    status: string;
    spec?: string;
    title: string;
    scopeFiles: string[];
    acceptanceCriteria?: string[];
  },
  before: ExternalItem,
  after: ExternalItem,
): ReconcileAction {
  const changed: string[] = [];
  if (before.title !== after.title) changed.push("title");
  if (before.body !== after.body) changed.push("body");
  if ([...before.labels].sort().join() !== [...after.labels].sort().join()) changed.push("labels");
  if (before.assignee !== after.assignee) changed.push("assignee");
  if (changed.length === 0) return { action: "none" };
  const running = ["in_progress", "verify"].includes(card.status);
  if (!running) return { action: "apply_on_completion", fields: changed };
  const scopeWords = (text: string) =>
    new Set<string>([
      ...(text.match(/[\w./-]+\.[a-z]{1,5}\b/g) ?? []),
      ...(text.match(/^\s*[-*]\s*\[.\].*$/gm) ?? []),
    ]);
  const b = scopeWords(before.body);
  const a = scopeWords(after.body);
  const scopeChanged =
    changed.includes("body") && (b.size !== a.size || [...a].some((x) => !b.has(x)));
  const criteriaChanged =
    changed.includes("body") &&
    /acceptance|criteria|must|should/i.test(after.body) &&
    after.body.replace(/\s+/g, " ") !== before.body.replace(/\s+/g, " ") &&
    (card.acceptanceCriteria ?? []).some((c) => !after.body.includes(c));
  if (scopeChanged || criteriaChanged) {
    return {
      action: "replan_on_completion",
      fields: changed,
      change: scopeChanged ? "scope" : "criteria",
    };
  }
  return { action: "apply_on_completion", fields: changed };
}
