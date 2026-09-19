import type { ExternalRef } from "@sekhemet/kernel";
import { GitHubClient, type GitHubEndpoints, type TokenProvider } from "./github_app.js";

/**
 * The generic tracker adapter (Y10, design "Adapter interface") and its
 * GitHub (Y10) and Forgejo (Y11) implementations. The board owns card
 * state, gate results and budgets; the tracker owns title, description,
 * assignee and labels. Shared fields resolve last-writer-wins by
 * timestamp, and the losing value is kept in the history.
 */
export interface ExternalItem {
  ref: ExternalRef;
  title: string;
  body: string;
  labels: string[];
  assignee?: string;
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
  assignee?: string;
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

/** Fields each side owns (design): the rest are shared, last writer wins. */
export const TRACKER_OWNED = ["title", "body", "assignee", "labels"] as const;

export interface FieldConflict {
  field: string;
  kept: unknown;
  lost: unknown;
  winner: "board" | "tracker";
  at: string;
}

/**
 * Merge a tracker item into a card, last writer wins per field, with the
 * losing value recorded. Card state stays the board's.
 */
export function mergeLastWriterWins(
  card: SyncCard,
  item: ExternalItem,
): { card: SyncCard; history: FieldConflict[] } {
  const trackerNewer = Date.parse(item.updatedAt) > Date.parse(card.updatedAt);
  const history: FieldConflict[] = [];
  const next: SyncCard = { ...card };
  const pairs: [keyof SyncCard, unknown, unknown][] = [
    ["title", card.title, item.title],
    ["spec", card.spec ?? "", item.body],
    ["labels", [...(card.labels ?? [])].sort(), [...item.labels].sort()],
    ["assignee", card.assignee, item.assignee],
  ];
  for (const [field, mine, theirs] of pairs) {
    if (JSON.stringify(mine) === JSON.stringify(theirs)) continue;
    const winner = trackerNewer ? "tracker" : "board";
    history.push({
      field,
      kept: winner === "tracker" ? theirs : mine,
      lost: winner === "tracker" ? mine : theirs,
      winner,
      at: trackerNewer ? item.updatedAt : card.updatedAt,
    });
    if (trackerNewer) (next as unknown as Record<string, unknown>)[field] = theirs;
  }
  if (trackerNewer) next.updatedAt = item.updatedAt;
  return { card: next, history };
}

function cardBody(card: SyncCard): string {
  return `${card.spec ?? ""}\n\n<!-- sekhemet:card=${card.id} -->`.trim();
}

/** GitHub Issues through the App client (REST; sub-issues via GraphQL when enabled). */
export class GitHubIssuesAdapter implements SyncAdapter {
  public readonly system = "github" as const;
  public readonly capabilities: SyncCapabilities = {
    hierarchy: true,
    dependencies: false,
    webhooks: true,
    maxDepth: 2,
  };
  private readonly client: GitHubClient;

  constructor(
    private readonly repo: { owner: string; repo: string },
    tokens: TokenProvider,
    endpoints?: GitHubEndpoints,
    client?: GitHubClient,
  ) {
    this.client = client ?? new GitHubClient(tokens, endpoints);
  }

  public async pull(since: string): Promise<ExternalItem[]> {
    const items = await this.client.rest<
      {
        number: number;
        html_url: string;
        title: string;
        body: string | null;
        labels: { name: string }[];
        assignee: { login: string } | null;
        state: string;
        updated_at: string;
        pull_request?: unknown;
      }[]
    >(
      "GET",
      `/repos/${this.repo.owner}/${this.repo.repo}/issues?state=all&per_page=100&since=${encodeURIComponent(since)}`,
    );
    return items
      .filter((i) => !i.pull_request)
      .map((i) => ({
        ref: { system: "github", id: String(i.number), url: i.html_url },
        title: i.title,
        body: i.body ?? "",
        labels: i.labels.map((l) => l.name),
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
      `/repos/${this.repo.owner}/${this.repo.repo}/issues`,
      { title: card.title, body: cardBody(card), labels: card.labels ?? [] },
    );
    return { system: "github", id: String(issue.number), url: issue.html_url };
  }

  public async update(ref: ExternalRef, patch: Partial<SyncCard>): Promise<void> {
    await this.client.rest(
      "PATCH",
      `/repos/${this.repo.owner}/${this.repo.repo}/issues/${ref.id}`,
      {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.spec !== undefined
          ? { body: cardBody({ ...(patch as SyncCard), id: patch.id ?? "" }) }
          : {}),
        ...(patch.labels !== undefined ? { labels: patch.labels } : {}),
        ...(patch.status === "done" ? { state: "closed" } : {}),
      },
    );
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
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl.replace(/\/+$/, "")}/api/v1${path}`, {
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
      body: i.body ?? "",
      labels: (i.labels ?? []).map((l) => l.name),
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
  | { action: "pause_and_ask"; fields: string[]; question: string };

/**
 * An issue edited externally while its card is running (Y20, design
 * [DESIGN] note): edits to non-scope fields are reconciled when the card
 * completes; a change to the scope or the acceptance criteria pauses the
 * card and asks, because the running work may no longer be the right work.
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
      action: "pause_and_ask",
      fields: changed,
      question: `The issue for "${card.title}" changed ${scopeChanged ? "its scope" : "its acceptance criteria"} while the card was running. Continue with the old version, or restart with the new one?`,
    };
  }
  return { action: "apply_on_completion", fields: changed };
}
