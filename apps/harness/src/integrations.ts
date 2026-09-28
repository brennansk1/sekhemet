import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import type { CardRecord, CardStore, EventLog } from "@sekhemet/kernel";
import {
  DELEGATE_LABEL,
  type GitHubClient,
  GitHubIssuesAdapter,
  type RateBudget,
  type SyncAdapter,
  openIssues,
} from "@sekhemet/sync";
import {
  egressRecorder,
  githubEndpoints,
  githubRepoOf,
  githubTransport,
  integrationFetch,
  integrationRefusal,
} from "./github_transport.js";
import { importProposals } from "./import_board.js";
import { keychainStore } from "./keychain.js";
import type { ProposalDraft } from "./pm/agent.js";
import { type Audience, soloAudience } from "./pm/audience.js";
import type { PmStore } from "./pm/store.js";
import { PM_EVENTS } from "./pm/types.js";
import { userDir } from "./user_dir.js";
import {
  type SyncDirection,
  forgejoFromEnv,
  mirrorAgentStatuses,
  syncViaAdapter,
} from "./wave2_github.js";

const run = promisify(execFile);

// --- Per-user, per-repo settings --------------------------------------------

/**
 * Integration settings live in the user's config directory, keyed by repo.
 *
 * Never in the repo: `.sekhemet/` is committed in many projects (gates.toml
 * lives there), and a Slack webhook URL is a credential. Anyone with it can
 * post to the channel.
 */
export interface IntegrationSettings {
  slackWebhookUrl?: string;
  /** A Slack bot token (`xoxb-…`) and the channel it posts to, instead of a webhook. */
  slackBotToken?: string;
  slackChannel?: string;
  /** The notice kinds Slack carries; every kind when unset (integrations item 21). */
  slackEvents?: import("./notify.js").NotifyEvent[];
  /** Unsolicited notices a day on Slack: 3 when unset, never more than 5 (item 23a). */
  slackDailyBudget?: number;
  /** When Seshat's daily standup is due, local `HH:MM`; 09:00 when unset (INT-18). */
  standupAt?: string;
  githubPrOnAccept?: boolean;
  /** The Researcher may search papers, the web and GitHub. */
  researchWeb?: boolean;
  /** Self-hosted push (ntfy or Gotify); see notify.ts. */
  push?: import("./notify.js").PushSettings;
  lastSync?: Record<string, string>;
}

function settingsPath(repoPath: string): string {
  let real = repoPath;
  try {
    real = realpathSync(repoPath);
  } catch {
    // Use the path as given.
  }
  const key = createHash("sha256").update(real).digest("hex").slice(0, 16);
  const base = userDir();
  return join(base, "repos", `${basename(real)}-${key}.json`);
}

/**
 * The token file's protection (security item 35, SEC-27): the file is 0600
 * and every directory from the Sekhemet user directory down to it is 0700,
 * wider modes on existing ones corrected. The sandbox cannot read the
 * directory either (item 10, SEC-23).
 */
function secureSettingsPath(path: string): void {
  const base = userDir();
  for (const dir of [base, dirname(path)]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if ((statSync(dir).mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
  }
  if (existsSync(path) && (statSync(path).mode & 0o777) !== 0o600) chmodSync(path, 0o600);
}

/**
 * The settings that are secrets (security item 35): a Slack webhook URL can
 * post to the channel, a push token to the phone. Where the host has a
 * keychain they live there (SEC-27a); the file keeps only their account names.
 */
const SECRET_FIELDS = ["slackWebhookUrl", "slackBotToken", "push.token"] as const;

/** The file as stored: the settings, less secrets kept in the keychain, which it names. */
type StoredSettings = IntegrationSettings & { keychain?: string[] };

function getField(o: object, field: string): unknown {
  return field.split(".").reduce<unknown>((v, k) => (v as Record<string, unknown>)?.[k], o);
}
function setField(o: object, field: string, value: unknown): void {
  const keys = field.split(".");
  let at = o as Record<string, unknown>;
  for (const k of keys.slice(0, -1)) {
    if (typeof at[k] !== "object" || at[k] === null) return;
    at = at[k] as Record<string, unknown>;
  }
  const last = keys.at(-1) as string;
  if (value === undefined) delete at[last];
  else at[last] = value;
}

/**
 * Write the settings file: each secret into the keychain when there is one
 * (a failed keychain write keeps that secret in the 0600 file, SEC-27), the
 * secrets it no longer holds removed from the keychain.
 */
function persistSettings(path: string, settings: IntegrationSettings, previous: string[]): void {
  const store = keychainStore();
  const out = structuredClone(settings) as StoredSettings;
  const accounts: string[] = [];
  if (store) {
    for (const field of SECRET_FIELDS) {
      const value = getField(settings, field);
      if (typeof value !== "string" || !value) continue;
      const account = `${basename(path, ".json")}:${field}`;
      try {
        store.set(account, value);
        setField(out, field, undefined);
        accounts.push(account);
      } catch {
        // The keychain refused: the 0600 file keeps this one.
      }
    }
    for (const account of previous) if (!accounts.includes(account)) store.delete(account);
  }
  if (accounts.length > 0) out.keychain = accounts;
  secureSettingsPath(path);
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
  // `mode` applies only when the file is created: an existing one is corrected.
  secureSettingsPath(path);
}

function readStored(path: string): StoredSettings {
  return JSON.parse(readFileSync(path, "utf8")) as StoredSettings;
}

export function readSettings(repoPath: string): IntegrationSettings {
  try {
    const path = settingsPath(repoPath);
    const { keychain: accounts = [], ...settings } = readStored(path);
    secureSettingsPath(path);
    const store = keychainStore();
    if (!store) return settings;
    // SEC-27a: an older file's tokens move into the keychain on this read.
    const plaintext = SECRET_FIELDS.some((f) => typeof getField(settings, f) === "string");
    for (const account of accounts) {
      const value = store.get(account);
      if (value !== undefined)
        setField(settings, account.slice(account.lastIndexOf(":") + 1), value);
    }
    if (plaintext) persistSettings(path, settings, accounts);
    return settings;
  } catch {
    return {};
  }
}

export function writeSettings(
  repoPath: string,
  patch: { [K in keyof IntegrationSettings]?: IntegrationSettings[K] | undefined },
): IntegrationSettings {
  const path = settingsPath(repoPath);
  let previous: string[] = [];
  try {
    previous = readStored(path).keychain ?? [];
  } catch {
    // No file yet.
  }
  // An undefined value in the patch removes that setting.
  const merged: Record<string, unknown> = { ...readSettings(repoPath), ...patch };
  for (const [k, v] of Object.entries(merged)) if (v === undefined) delete merged[k];
  const next = merged as IntegrationSettings;
  persistSettings(path, next, previous);
  return next;
}

// --- Catalogue ----------------------------------------------------------------

type Tier = "now" | "next" | "later";
type Via = "gh-cli" | "csv" | "webhook" | "api";

export interface IntegrationEntry {
  id: string;
  name: string;
  tier: Tier;
  connected: boolean;
  detail?: string;
  lastSyncAt?: string;
  via: Via;
  enabled?: boolean;
}

const CATALOGUE: Omit<IntegrationEntry, "connected">[] = [
  { id: "github", name: "GitHub Issues and Projects", tier: "now", via: "gh-cli" },
  { id: "github-pr", name: "GitHub pull request on accept", tier: "now", via: "gh-cli" },
  { id: "jira", name: "Jira import and export", tier: "now", via: "csv" },
  { id: "linear", name: "Linear import and export", tier: "now", via: "csv" },
  { id: "slack", name: "Slack for the PM", tier: "now", via: "webhook" },
  { id: "research-web", name: "Research model web access", tier: "now", via: "api" },
  { id: "push", name: "Push notifications (ntfy or Gotify)", tier: "now", via: "webhook" },
  { id: "jira-sync", name: "Jira live sync", tier: "next", via: "api" },
  { id: "linear-sync", name: "Linear live sync", tier: "next", via: "api" },
  { id: "github-actions", name: "GitHub Actions checks mirror", tier: "next", via: "gh-cli" },
  { id: "teams", name: "Microsoft Teams", tier: "next", via: "webhook" },
  { id: "slack-replies", name: "Reply to the PM from Slack", tier: "next", via: "api" },
  { id: "sentry", name: "Sentry errors as proposed issues", tier: "later", via: "api" },
  { id: "datadog", name: "Datadog regressions as proposed issues", tier: "later", via: "api" },
  { id: "pagerduty", name: "PagerDuty follow-ups as proposed issues", tier: "later", via: "api" },
  { id: "notion", name: "Notion publishing", tier: "later", via: "api" },
  { id: "confluence", name: "Confluence publishing", tier: "later", via: "api" },
];

export async function listIntegrations(repoPath: string): Promise<IntegrationEntry[]> {
  const settings = readSettings(repoPath);
  const found = await githubRepoOf(repoPath);
  // Offline by default (integrations §4): a connected repository the network
  // policy cannot reach says so, naming the setting.
  const refused = found.repo ? integrationRefusal(repoPath, githubEndpoints().apiUrl) : undefined;
  const blocked = refused ? ` — blocked by network mode (${refused.reason}): ${refused.hint}` : "";
  const gh = {
    repo: found.repo ? `${found.repo}${blocked}` : undefined,
    error: found.error?.message,
  };
  return CATALOGUE.map((entry) => {
    const lastSyncAt = settings.lastSync?.[entry.id];
    const base = { ...entry, ...(lastSyncAt ? { lastSyncAt } : {}) };
    switch (entry.id) {
      case "github":
        return { ...base, connected: Boolean(gh.repo), detail: gh.repo ?? gh.error ?? "" };
      case "github-pr":
        return {
          ...base,
          connected: Boolean(gh.repo),
          enabled: settings.githubPrOnAccept === true,
          detail: gh.repo
            ? settings.githubPrOnAccept
              ? `Accept opens a pull request on ${gh.repo}`
              : `Off: Accept merges locally${blocked}`
            : (gh.error ?? ""),
        };
      case "jira":
      case "linear":
        return { ...base, connected: true, detail: "CSV import and export, no account needed" };
      case "research-web": {
        const provider = process.env.SEKHEMET_SEARXNG_URL
          ? "SearXNG"
          : process.env.BRAVE_SEARCH_API_KEY
            ? "Brave Search"
            : process.env.TAVILY_API_KEY
              ? "Tavily"
              : undefined;
        return {
          ...base,
          connected: settings.researchWeb === true,
          enabled: settings.researchWeb === true,
          detail: `${settings.researchWeb ? "On" : "Off"}: papers (arXiv, OpenAlex, Hugging Face), documentation, page reads and GitHub. Web search: ${provider ?? "a private SearXNG starts on this machine when Docker is available; or set BRAVE_SEARCH_API_KEY or TAVILY_API_KEY"}.`,
        };
      }
      case "push": {
        const p = settings.push;
        return {
          ...base,
          connected: Boolean(p),
          detail: p
            ? `${p.kind === "ntfy" ? `ntfy topic ${p.topic}` : "Gotify"} at ${new URL(p.url).host}; ${(p.events ?? ["review", "parked", "budget", "question", "run_report"]).join(", ")}`
            : "Not connected: a self-hosted ntfy or Gotify server pushes review, park, budget and question alerts to your phone",
        };
      }
      case "slack":
        return {
          ...base,
          connected: Boolean(settings.slackWebhookUrl || settings.slackBotToken),
          detail: settings.slackWebhookUrl
            ? "Webhook set"
            : settings.slackBotToken
              ? "Bot token set"
              : "Not connected",
        };
      default:
        return {
          ...base,
          connected: false,
          detail: entry.tier === "next" ? "Planned next" : "Planned later",
        };
    }
  });
}

// --- Slack --------------------------------------------------------------------

/**
 * Post one message to Slack, when it is connected: the Slack channel of the
 * one notifier (`slack.ts`), through the one network policy, recorded as
 * `pm/notify`. Returns false when not connected.
 */
export async function notifySlack(
  repoPath: string,
  log: EventLog | undefined,
  kind: "standup" | "needs_you" | "run_report" | "test",
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  const { sendSlack } = await import("./slack.js");
  const r = await sendSlack(repoPath, { event: kind, title: "Sekhemet", message: text }, { log });
  return r.skipped ? { ok: false, error: "Slack is not connected" } : r;
}

// --- CSV ------------------------------------------------------------------------

export function toCsv(rows: string[][]): string {
  const cell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return `${rows.map((r) => r.map(cell).join(",")).join("\r\n")}\r\n`;
}

export { parseCsv } from "./import_board.js";

// --- Export / import ------------------------------------------------------------

const JIRA_PRIORITY = ["", "Highest", "High", "Medium", "Low"];
const LINEAR_PRIORITY = ["No priority", "Urgent", "High", "Medium", "Low"];
const JIRA_STATUS: Record<string, string> = {
  backlog: "Backlog",
  ready: "To Do",
  planning: "To Do",
  in_progress: "In Progress",
  verify: "In Review",
  review: "In Review",
  done: "Done",
  parked: "On Hold",
  rejected: "Won't Do",
};
const cleanTitle = (t: string) => t.replace(/\s*\(SPIDR:[^)]*\)\s*$/, "");

export type ExportFormat = "jira-csv" | "linear-csv" | "github-json" | "json";

/** The people's tracker logins, for writing a card's owner as an assignee (INT-36). */
export interface ExportPeople {
  handleOf(principal: string, system: string): string | undefined;
}

export function exportBoard(
  cards: CardRecord[],
  cycles: { id: string; name: string }[],
  format: ExportFormat,
  people?: ExportPeople,
): { body: string; contentType: string; ext: string } {
  // INT-36: the Worker is a delegate label, never a user; the owner is the
  // assignee where the tool has the person's login (GitHub).
  const labelsOf = (c: CardRecord) => [
    ...(c.labels ?? []).filter((l) => l !== DELEGATE_LABEL),
    ...(c.delegate?.kind === "worker" ? [DELEGATE_LABEL] : []),
  ];
  const cycleName = (id?: string) => cycles.find((c) => c.id === id)?.name ?? "";
  const epicTitle = (id?: string) => cleanTitle(cards.find((c) => c.id === id)?.title ?? "");
  const describe = (c: CardRecord) =>
    [
      c.spec ?? "",
      c.acceptanceCriteria?.length
        ? `Done when:\n${c.acceptanceCriteria.map((a) => `- ${a}`).join("\n")}`
        : "",
      c.scopeFiles.length ? `Files: ${c.scopeFiles.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  const work = cards.filter((c) => c.tier !== "epic");

  if (format === "jira-csv") {
    const rows = [
      [
        "Summary",
        "Issue Type",
        "Status",
        "Priority",
        "Story Points",
        "Sprint",
        "Epic Link",
        "Labels",
        "Due Date",
        "Description",
        "Sekhemet ID",
      ],
      ...cards.map((c) => [
        cleanTitle(c.title),
        c.tier === "epic" ? "Epic" : "Story",
        JIRA_STATUS[c.status] ?? c.status,
        JIRA_PRIORITY[c.priority ?? 0] ?? "",
        c.estimate !== undefined ? String(c.estimate) : "",
        cycleName(c.cycleId),
        epicTitle(c.epicId),
        labelsOf(c).join(" "),
        c.dueDate ?? "",
        describe(c),
        c.id,
      ]),
    ];
    return { body: toCsv(rows), contentType: "text/csv; charset=utf-8", ext: "csv" };
  }
  if (format === "linear-csv") {
    const rows = [
      [
        "Title",
        "Description",
        "Status",
        "Priority",
        "Estimate",
        "Cycle",
        "Project",
        "Labels",
        "Due Date",
        "ID",
      ],
      ...work.map((c) => [
        cleanTitle(c.title),
        describe(c),
        JIRA_STATUS[c.status] ?? c.status,
        LINEAR_PRIORITY[c.priority ?? 0] ?? "No priority",
        c.estimate !== undefined ? String(c.estimate) : "",
        cycleName(c.cycleId),
        epicTitle(c.epicId),
        labelsOf(c).join(","),
        c.dueDate ?? "",
        c.id,
      ]),
    ];
    return { body: toCsv(rows), contentType: "text/csv; charset=utf-8", ext: "csv" };
  }
  if (format === "github-json") {
    const issues = work.map((c) => ({
      title: cleanTitle(c.title),
      body: describe(c),
      ...(() => {
        const login = c.owner ? people?.handleOf(c.owner, "github") : undefined;
        return login ? { assignees: [login] } : {};
      })(),
      labels: [
        ...labelsOf(c),
        ...(c.priority ? [`priority:${LINEAR_PRIORITY[c.priority]?.toLowerCase()}`] : []),
        ...(c.estimate !== undefined ? [`estimate:${c.estimate}`] : []),
      ],
      state: c.status === "done" || c.status === "rejected" ? "closed" : "open",
      milestone: cycleName(c.cycleId) || undefined,
      sekhemet_id: c.id,
    }));
    return {
      body: `${JSON.stringify(issues, null, 2)}\n`,
      contentType: "application/json",
      ext: "json",
    };
  }
  return {
    // The derived `assignee` ("worker", "human") is not a person: owner and delegate say it.
    body: `${JSON.stringify({ cards: cards.map(({ assignee: _a, ...c }) => c), cycles }, null, 2)}\n`,
    contentType: "application/json",
    ext: "json",
  };
}

/**
 * Parse another tool's export into card drafts, all of them new cards: the
 * board-aware form, which updates the cards a row already is, is
 * `importProposals` (NEW-integrations-1).
 */
export function importDrafts(format: string, content: string): ProposalDraft[] {
  return importProposals(format, content, []);
}

// --- GitHub sync ----------------------------------------------------------------

/**
 * On the `gh` transport the login is the install's own person's: link it
 * once, so their cards' owner is written as their login (integrations item 6).
 * Nothing is linked when the lookup fails; the sync goes on.
 */
async function linkLocalLogin(
  cardStore: CardStore,
  client: { rest<T>(m: string, p: string): Promise<T> },
): Promise<void> {
  const me = cardStore.localPrincipal();
  if (cardStore.handleOf(me, "github")) return;
  try {
    const user = await client.rest<{ login?: string }>("GET", "/user");
    if (user?.login && !cardStore.principalForHandle("github", user.login)) {
      await cardStore.linkIdentity(me, "github", user.login, me, "harness");
    }
  } catch {
    // Unknown login: the owner is not written as an assignee until linked.
  }
}

/**
 * Two-way sync with GitHub Issues (integrations items 7–11): one adapter over
 * one client, whichever transport — the GitHub App when configured, else the
 * user's own `gh` login — or Forgejo when that is configured. Every issue is
 * pulled, page by page; shared fields merge three ways against the last
 * snapshot, so an edit on either side is kept (`syncViaAdapter`).
 */
export async function syncGithub(
  repoPath: string,
  cardStore: CardStore,
  /** M6: `pull` takes the tracker's changes and sends nothing; `push` sends and changes nothing here. */
  direction: SyncDirection,
  eventLog?: EventLog,
): Promise<{
  created: number;
  updated: number;
  skipped: number;
  /** Cards not written because the tracker nests less deeply (INT-11e). */
  clamped: { id: string; ancestor: string }[];
  errors: string[];
  /** GitHub's two meters as this sync saw them, apart (INT-11c). */
  budget?: { rest: RateBudget; graphql: RateBudget };
}> {
  const out = {
    created: 0,
    updated: 0,
    skipped: 0,
    clamped: [] as { id: string; ancestor: string }[],
    errors: [] as string[],
  };
  if (!eventLog) {
    out.errors.push("The sync needs the ledger");
    return out;
  }
  const record = egressRecorder(eventLog);
  let adapter: SyncAdapter | undefined = forgejoFromEnv((url) =>
    integrationFetch(repoPath, record, url, "integration:forgejo"),
  );
  let github: { client: GitHubClient; repo: { owner: string; repo: string } } | undefined;
  if (!adapter) {
    try {
      const t = await githubTransport(repoPath, record);
      // INT-11c: a page of issues with their sub-issues and labels in one GraphQL query.
      adapter = new GitHubIssuesAdapter(t.repo, t.client, { pull: "graphql" });
      github = { client: t.client, repo: t.repo };
      // Linking the login changes the board's people: not on a push (M6).
      if (t.kind === "gh" && direction !== "push") await linkLocalLogin(cardStore, t.client);
    } catch (err) {
      out.errors.push(err instanceof Error ? err.message : String(err));
      return out;
    }
  }
  const since = readSettings(repoPath).lastSync?.[adapter.system] ?? "1970-01-01T00:00:00Z";
  const started = new Date().toISOString();
  const r = await syncViaAdapter(adapter, cardStore, eventLog, since, direction);
  // The next pull starts where this one did: an edit made during it is not
  // missed. A push took nothing, so it moves nothing on (M6).
  if (r.errors.length === 0 && direction !== "push") {
    writeSettings(repoPath, {
      lastSync: { ...(readSettings(repoPath).lastSync ?? {}), [adapter.system]: started },
    });
  }
  // INT-20b: a sync that sends also shows each linked card's state on its issue.
  if (github && direction !== "pull") {
    const m = await mirrorAgentStatuses(repoPath, cardStore, eventLog, {
      adapter,
      repo: github.repo,
    }).catch((err: unknown) => ({
      errors: [err instanceof Error ? err.message : String(err)],
    }));
    r.errors.push(...m.errors.map((e) => `agent status: ${e}`));
  }
  return {
    created: r.created + r.linked,
    updated: r.updated + r.pushed,
    skipped: 0,
    clamped: r.clamped,
    errors: r.errors,
    ...(github ? { budget: github.client.budget() } : {}),
  };
}

// --- Inherited issues (take-over) ------------------------------------------------

/**
 * The tracker this repository is connected to, through the one adapter and
 * the network policy (integrations items 7–9): Forgejo when configured, else
 * GitHub when the repository has a GitHub remote and the policy reaches it.
 * GitHub's issues are read through the REST pull. Without one, the reason.
 */
export async function connectedTracker(
  repoPath: string,
  log?: EventLog,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ tracker?: SyncAdapter; reason: string }> {
  const record = log ? egressRecorder(log) : undefined;
  const forgejo = forgejoFromEnv(
    (url) => integrationFetch(repoPath, record, url, "integration:forgejo"),
    env,
  );
  if (forgejo) return { tracker: forgejo, reason: "forgejo" };
  const found = await githubRepoOf(repoPath, env);
  if (!found.repo) return { reason: "no tracker connected" };
  const refused = integrationRefusal(repoPath, githubEndpoints(env).apiUrl);
  if (refused) return { reason: `blocked by network mode (${refused.reason}): ${refused.hint}` };
  try {
    const t = await githubTransport(repoPath, record, env);
    return { tracker: new GitHubIssuesAdapter(t.repo, t.client), reason: "github" };
  } catch (err) {
    return { reason: err instanceof Error ? err.message : String(err) };
  }
}

/** What a verdict's evidence says, for the tracker's comment. */
function evidenceText(e: { kind: string; ref: string; run?: string }): string {
  if (e.kind === "commit") return `commit ${e.ref.slice(0, 12)}`;
  if (e.kind === "issue") return `issue ${e.ref}`;
  if (e.kind === "test") return `test ${e.ref}${e.run ? ` (run ${e.run})` : ""}`;
  return e.ref;
}

/**
 * A person applies a reconciliation of inherited issues (design-stage
 * DS-TO-13; integrations INT-43): each verdict is written through the one
 * adapter — *done* and *duplicate* closed with a comment citing the
 * evidence, *stale* labelled `stale` with a comment; a *valid* issue is left
 * as it is (its card carries its `externalRef`) — only to the tracker the
 * issues were read from; then the kernel records who applied it. A failed
 * write leaves it open, so the person retries it. Nothing is written before
 * the person's apply.
 */
export async function applyIssueReconciliation(
  store: CardStore,
  tracker: Pick<SyncAdapter, "system" | "pull" | "update"> & Partial<Pick<SyncAdapter, "comment">>,
  id: string,
  principal: string,
): Promise<{ applied: boolean; written: string[]; errors: string[] }> {
  const proposal = await store.reconciliation.get(id);
  if (!proposal) throw new Error(`No reconciliation ${id}`);
  if (proposal.state !== "open")
    throw new Error(`Reconciliation ${id} was already ${proposal.state}`);
  // The issues were read from one tracker: written only to that one.
  const other = proposal.issues.find((i) => i.issue.system !== tracker.system);
  if (other) {
    throw new Error(
      `Nothing applied: ${other.issue.id} was read from ${other.issue.system}, and the connected tracker is ${tracker.system}.`,
    );
  }
  const open = new Map((await openIssues(tracker)).map((i) => [i.ref.id, i]));
  const out = { written: [] as string[], errors: [] as string[] };
  // A write that failed (a network error, an expired token) leaves the
  // proposal open so the person can retry it; an issue already closed is not
  // open any more, so a retry never closes or comments on it twice.
  let failed = false;
  for (const i of proposal.issues) {
    if (i.verdict === "valid") continue;
    const item = open.get(i.issue.id);
    if (!item) {
      out.errors.push(`${i.issue.id}: no longer open on the tracker; left as it is`);
      continue;
    }
    const cites = i.evidence.map(evidenceText).join(", ");
    const body =
      i.verdict === "done"
        ? `Sekhemet's take-over found this already done: ${cites}. Closed on ${principal}'s approval.`
        : i.verdict === "duplicate"
          ? `Sekhemet's take-over found this a duplicate of ${cites}. Closed on ${principal}'s approval.`
          : `Sekhemet's take-over found this stale: ${cites}. Labelled on ${principal}'s approval.`;
    try {
      await tracker.update(
        item.ref,
        i.verdict === "stale"
          ? {
              labels: [...item.labels.filter((l) => l !== "stale"), "stale"],
              ...(item.delegatedToWorker ? { delegate: "worker" as const } : {}),
            }
          : { status: "done" },
      );
      await tracker.comment?.(item.ref, body);
      out.written.push(i.issue.id);
    } catch (err) {
      failed = true;
      out.errors.push(`${i.issue.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (!failed) await store.reconciliation.apply(id, principal);
  return { applied: !failed, ...out };
}

// --- Take over a project (routes) ---------------------------------------------

/** What the dashboard shows of a take-over: the records, with their private text (the person's view). */
async function takeoverState(store: CardStore): Promise<Record<string, unknown>> {
  const inv = store.takeover.inventory();
  const batch = inv
    ? (await store.eventsOfType(["takeover/questions_posted"])).find(
        (e) => (e.payload as { inventorySeq?: number }).inventorySeq === inv.seq,
      )
    : undefined;
  const questions = (
    (batch?.payload as { questions?: { decisionId: string; rank: number; defaultCites: string }[] })
      ?.questions ?? []
  ).map((q) => {
    const d = store.runs.getDecision(q.decisionId);
    return {
      ...q,
      question: d?.question,
      options: d?.options,
      status: d?.status,
      ...(d?.selectedOptionIndex !== undefined ? { answer: d.selectedOptionIndex } : {}),
    };
  });
  const latest = (await store.eventsOfType(["takeover/backlog_proposed"])).at(-1);
  const proposalId = (latest?.payload as { proposalId?: string } | undefined)?.proposalId;
  const backlog = proposalId ? await store.takeover.backlog(proposalId) : undefined;
  return {
    inventory: inv ?? null,
    brief: (await store.takeover.briefAsFound()) ?? null,
    questions,
    backlog: backlog
      ? { ...backlog, approved: store.takeover.isPlanApproved(backlog.proposalId) }
      : null,
    reconciliations: await store.reconciliation.open(),
  };
}

/** Seshat's words on a take-over just run: counts and ids only, never repository text (DS-TO-10). */
function takeoverSummary(r: import("./takeover.js").TakeoverReport): string {
  const n = r.findings.length;
  if (!r.trusted) {
    return `I read the repository as it is: ${n} finding${n === 1 ? "" : "s"} from its files and history, nothing of it run. Trust the repository to let me install, build and run its tests, confined, then take it over again.`;
  }
  const plan = r.plan;
  if (!plan) return `Take-over: ${n} finding${n === 1 ? "" : "s"} in the inventory.`;
  const count = (label: string) => plan.claims.filter((c) => c.label === label).length;
  return [
    `Take-over: ${n} finding${n === 1 ? "" : "s"} in the inventory.`,
    `The brief as found has ${count("proven")} proven, ${count("claimed_unproven")} claimed but unproven and ${count("contradicted")} contradicted claim${plan.claims.length === 1 ? "" : "s"}.`,
    plan.questions.length > 0
      ? `${plan.questions.length} question${plan.questions.length === 1 ? " waits" : "s wait"} in your decisions, each with a safe default.`
      : "",
    plan.reconciliation
      ? `${plan.reconciliation.issues.length} inherited issue${plan.reconciliation.issues.length === 1 ? " is" : "s are"} proposed as done, duplicate, stale or valid (${plan.reconciliation.id}); the tracker changes only when you apply it.`
      : "",
    plan.proposalId
      ? `The plan is ${plan.proposalId}: nothing is created until you approve it.`
      : "There was nothing to plan.",
  ]
    .filter(Boolean)
    .join(" ");
}

let takeoverRunning = false;

// --- Routes ---------------------------------------------------------------------

export interface IntegrationsContext {
  repoPath: string;
  log: EventLog;
  cardStore?: CardStore;
  pmStore: PmStore;
  json: (res: ServerResponse, status: number, body: unknown) => void;
  readJsonBody: (req: IncomingMessage, limit?: number) => Promise<Record<string, unknown>>;
  mutationGuard: (req: IncomingMessage, res: ServerResponse) => CardStore | undefined;
  /** The person a request is for (teams §2.3, kernel rule 19). */
  principalOf?: (req: IncomingMessage) => string;
  /** Who can see which project (PM-N9-8); Solo sees everything. */
  audience?: () => Audience;
}

export async function handleIntegrationsApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  query: URLSearchParams,
  ctx: IntegrationsContext,
): Promise<boolean> {
  if (url === "/api/integrations" && req.method === "GET") {
    ctx.json(res, 200, await listIntegrations(ctx.repoPath));
    return true;
  }

  if (url === "/api/integrations/research-web" && req.method === "PUT") {
    if (!ctx.mutationGuard(req, res)) return true;
    const b = await ctx.readJsonBody(req);
    writeSettings(ctx.repoPath, { researchWeb: b.enabled === true });
    ctx.json(
      res,
      200,
      (await listIntegrations(ctx.repoPath)).find((i) => i.id === "research-web"),
    );
    return true;
  }

  if (url === "/api/integrations/github-pr" && req.method === "PUT") {
    if (!ctx.mutationGuard(req, res)) return true;
    const b = await ctx.readJsonBody(req);
    writeSettings(ctx.repoPath, { githubPrOnAccept: b.enabled === true });
    ctx.json(
      res,
      200,
      (await listIntegrations(ctx.repoPath)).find((i) => i.id === "github-pr"),
    );
    return true;
  }

  if (url === "/api/integrations/slack" && (req.method === "PUT" || req.method === "DELETE")) {
    if (!ctx.mutationGuard(req, res)) return true;
    if (req.method === "DELETE") {
      // Disconnect means every Slack credential: the webhook and the bot token.
      writeSettings(ctx.repoPath, {
        slackWebhookUrl: undefined,
        slackBotToken: undefined,
        slackChannel: undefined,
      });
    } else {
      const b = await ctx.readJsonBody(req);
      const hook = typeof b.webhookUrl === "string" ? b.webhookUrl.trim() : "";
      if (!/^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+$/.test(hook)) {
        ctx.json(res, 400, {
          error: "That is not a Slack incoming-webhook URL (https://hooks.slack.com/services/…)",
        });
        return true;
      }
      writeSettings(ctx.repoPath, { slackWebhookUrl: hook });
    }
    ctx.json(
      res,
      200,
      (await listIntegrations(ctx.repoPath)).find((i) => i.id === "slack"),
    );
    return true;
  }

  if (url === "/api/integrations/push" && (req.method === "PUT" || req.method === "DELETE")) {
    if (!ctx.mutationGuard(req, res)) return true;
    const { validatePush, writePush, ALL_EVENTS } = await import("./notify.js");
    if (req.method === "DELETE") {
      writePush(ctx.repoPath, undefined);
    } else {
      const b = await ctx.readJsonBody(req);
      const events = Array.isArray(b.events)
        ? (b.events as unknown[]).filter((e): e is (typeof ALL_EVENTS)[number] =>
            (ALL_EVENTS as string[]).includes(String(e)),
          )
        : undefined;
      const push = {
        kind: b.kind as "ntfy" | "gotify",
        url: String(b.url ?? "").trim(),
        ...(typeof b.topic === "string" && b.topic ? { topic: b.topic.trim() } : {}),
        ...(typeof b.token === "string" && b.token ? { token: b.token.trim() } : {}),
        ...(events ? { events } : {}),
      };
      const bad = validatePush(push);
      if (bad) {
        ctx.json(res, 400, { error: bad });
        return true;
      }
      writePush(ctx.repoPath, push);
    }
    ctx.json(
      res,
      200,
      (await listIntegrations(ctx.repoPath)).find((i) => i.id === "push"),
    );
    return true;
  }

  if (url === "/api/integrations/push/test" && req.method === "POST") {
    if (!ctx.mutationGuard(req, res)) return true;
    const { sendPush } = await import("./notify.js");
    ctx.json(
      res,
      200,
      await sendPush(
        ctx.repoPath,
        { event: "test", title: "Sekhemet", message: `Push works for ${basename(ctx.repoPath)}.` },
        { log: ctx.log },
      ),
    );
    return true;
  }

  if (url === "/api/integrations/slack/test" && req.method === "POST") {
    if (!ctx.mutationGuard(req, res)) return true;
    ctx.json(
      res,
      200,
      await notifySlack(
        ctx.repoPath,
        ctx.log,
        "test",
        `Sekhemet is connected to ${basename(ctx.repoPath)}. The PM will post standups and reviews here.`,
      ),
    );
    return true;
  }

  if (url === "/api/integrations/github/sync" && req.method === "POST") {
    const cardStore = ctx.mutationGuard(req, res);
    if (!cardStore) return true;
    const b = await ctx.readJsonBody(req);
    const direction = b.direction === "pull" || b.direction === "push" ? b.direction : "both";
    ctx.json(res, 200, await syncGithub(ctx.repoPath, cardStore, direction, ctx.log));
    return true;
  }

  if (url === "/api/takeover" && req.method === "GET") {
    if (!ctx.cardStore) {
      ctx.json(res, 501, { error: "This server was started read-only" });
      return true;
    }
    // PM-N9-8: the records hold the repository's private text (the recon,
    // the brief as found, the backlog), so, as in Seshat's snapshot, only a
    // person who sees every project reads them.
    const audience = ctx.audience?.() ?? soloAudience();
    const asker = ctx.principalOf?.(req) ?? ctx.log.localPrincipal();
    if (!ctx.cardStore.listProjects().every((p) => audience.canSee(asker, p.id))) {
      ctx.json(res, 404, { error: "No take-over you can see" });
      return true;
    }
    ctx.json(res, 200, await takeoverState(ctx.cardStore));
    return true;
  }

  if (url === "/api/takeover" && req.method === "POST") {
    // DS-TO-16: the empty board's Take over a project. Steps 1–3 always;
    // 4–6 once the repository is trusted (design-stage §2.10).
    const cardStore = ctx.mutationGuard(req, res);
    if (!cardStore) return true;
    if (takeoverRunning) {
      ctx.json(res, 409, { error: "A take-over is already running" });
      return true;
    }
    takeoverRunning = true;
    try {
      const { runTakeover } = await import("./takeover.js");
      const principal = ctx.principalOf?.(req) ?? cardStore.localPrincipal();
      const report = await runTakeover(ctx.repoPath, {
        store: cardStore,
        log: ctx.log,
        principal,
        say: () => undefined,
      });
      await ctx.pmStore.appendReply({ replyTo: [], text: takeoverSummary(report) });
      ctx.json(res, 200, {
        trusted: report.trusted,
        wouldRun: report.wouldRun,
        ...(await takeoverState(cardStore)),
      });
    } catch (err) {
      ctx.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    } finally {
      takeoverRunning = false;
    }
    return true;
  }

  if (url === "/api/takeover/approve" && req.method === "POST") {
    // DS-TO-14: the person approves the plan; its cards are created.
    const cardStore = ctx.mutationGuard(req, res);
    if (!cardStore) return true;
    const b = await ctx.readJsonBody(req);
    const proposalId = typeof b.proposalId === "string" ? b.proposalId : "";
    const { approveTakeoverPlan } = await import("./takeover_backlog.js");
    try {
      const r = await approveTakeoverPlan(
        { repoPath: ctx.repoPath, cardStore, log: ctx.log },
        { proposalId, ...(typeof b.projectId === "string" ? { projectId: b.projectId } : {}) },
        ctx.principalOf?.(req) ?? cardStore.localPrincipal(),
      );
      ctx.json(res, 200, { ...r, cards: r.cards.map((c) => c.id) });
    } catch (err) {
      ctx.json(res, 409, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if (
    (url === "/api/takeover/reconciliation/apply" ||
      url === "/api/takeover/reconciliation/dismiss") &&
    req.method === "POST"
  ) {
    // DS-TO-13, INT-43: only a person changes the tracker, through the one adapter.
    const cardStore = ctx.mutationGuard(req, res);
    if (!cardStore) return true;
    const b = await ctx.readJsonBody(req);
    const id = typeof b.id === "string" ? b.id : "";
    const principal = ctx.principalOf?.(req) ?? cardStore.localPrincipal();
    try {
      if (url.endsWith("/dismiss")) {
        await cardStore.reconciliation.dismiss(id, principal);
        ctx.json(res, 200, { id, state: "dismissed" });
        return true;
      }
      const found = await connectedTracker(ctx.repoPath, ctx.log);
      if (!found.tracker) {
        ctx.json(res, 409, { error: `Nothing applied: ${found.reason}` });
        return true;
      }
      const r = await applyIssueReconciliation(cardStore, found.tracker, id, principal);
      ctx.json(res, 200, { id, state: r.applied ? "applied" : "open", ...r });
    } catch (err) {
      ctx.json(res, 409, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if (url === "/api/export" && req.method === "GET") {
    const format = (query.get("format") ?? "json") as ExportFormat;
    if (!["jira-csv", "linear-csv", "github-json", "json"].includes(format)) {
      ctx.json(res, 400, { error: `Unknown format ${format}` });
      return true;
    }
    if (!ctx.cardStore) {
      ctx.json(res, 501, { error: "This server was started read-only" });
      return true;
    }
    const store = ctx.cardStore;
    const out = exportBoard(await store.listCards(), await ctx.pmStore.cycles(), format, {
      handleOf: (p, sys) => store.handleOf(p, sys),
    });
    const name = `sekhemet-${basename(ctx.repoPath).replace(/[^A-Za-z0-9._-]/g, "_")}-${format}.${out.ext}`;
    res.writeHead(200, {
      "Content-Type": out.contentType,
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    });
    res.end(out.body);
    return true;
  }

  if (url === "/api/import" && req.method === "POST") {
    if (!ctx.mutationGuard(req, res)) return true;
    let body: Record<string, unknown>;
    try {
      body = await ctx.readJsonBody(req, 2_000_000);
    } catch (err) {
      ctx.json(res, 413, { error: err instanceof Error ? err.message : String(err) });
      return true;
    }
    const format = typeof body.format === "string" ? body.format : "";
    const content = typeof body.content === "string" ? body.content : "";
    let drafts: ProposalDraft[];
    try {
      // INT-27: a row that is already a card updates it; INT-28: a malformed
      // CSV is refused with the line named.
      drafts = importProposals(format, content, (await ctx.cardStore?.listCards()) ?? []);
    } catch (err) {
      ctx.json(res, 400, {
        error: `Could not read that file: ${err instanceof Error ? err.message : String(err)}`,
      });
      return true;
    }
    if (drafts.length === 0) {
      if (importDrafts(format, content).length > 0) {
        // Every row is already a card and changes nothing: an idempotent re-import.
        ctx.json(res, 200, { proposals: [], unchanged: true });
        return true;
      }
      ctx.json(res, 400, { error: "No issues found. The file needs a Summary or Title column." });
      return true;
    }
    // Stored as a PM message so each import proposal is applied or discarded
    // through exactly the same flow as the PM's own.
    const reply = await ctx.pmStore.appendReply({
      replyTo: [],
      text: `Import preview: ${drafts.length} issue${drafts.length === 1 ? "" : "s"} from ${format}. Apply the ones you want.`,
      proposals: drafts.slice(0, 500),
    });
    ctx.json(res, 200, { proposals: reply.proposals ?? [], messageId: reply.id });
    return true;
  }

  return false;
}
