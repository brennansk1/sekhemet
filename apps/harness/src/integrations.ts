import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { CardRecord, CardStore, EventLog } from "@sekhemet/kernel";
import type { ProposalDraft } from "./pm/agent.js";
import type { PmStore } from "./pm/store.js";
import { PM_EVENTS } from "./pm/types.js";
import { syncViaAdapter, trackerFromEnv } from "./wave2_github.js";
import { githubAppFromEnv } from "./wave2_server.js";

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
  const base = process.env.SEKHEMET_CONFIG_DIR ?? join(homedir(), ".config", "sekhemet");
  return join(base, "repos", `${basename(real)}-${key}.json`);
}

export function readSettings(repoPath: string): IntegrationSettings {
  try {
    return JSON.parse(readFileSync(settingsPath(repoPath), "utf8")) as IntegrationSettings;
  } catch {
    return {};
  }
}

export function writeSettings(
  repoPath: string,
  patch: { [K in keyof IntegrationSettings]?: IntegrationSettings[K] | undefined },
): IntegrationSettings {
  const path = settingsPath(repoPath);
  // An undefined value in the patch removes that setting.
  const merged: Record<string, unknown> = { ...readSettings(repoPath), ...patch };
  for (const [k, v] of Object.entries(merged)) if (v === undefined) delete merged[k];
  const next = merged as IntegrationSettings;
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
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
  { id: "research-web", name: "Researcher web access", tier: "now", via: "api" },
  { id: "push", name: "Push notifications (ntfy or Gotify)", tier: "now", via: "webhook" },
  { id: "jira-sync", name: "Jira live sync", tier: "next", via: "api" },
  { id: "linear-sync", name: "Linear live sync", tier: "next", via: "api" },
  { id: "github-actions", name: "GitHub Actions gate mirror", tier: "next", via: "gh-cli" },
  { id: "teams", name: "Microsoft Teams", tier: "next", via: "webhook" },
  { id: "slack-replies", name: "Reply to the PM from Slack", tier: "next", via: "api" },
  { id: "sentry", name: "Sentry errors as proposed cards", tier: "later", via: "api" },
  { id: "datadog", name: "Datadog regressions as proposed cards", tier: "later", via: "api" },
  { id: "pagerduty", name: "PagerDuty follow-ups as proposed cards", tier: "later", via: "api" },
  { id: "notion", name: "Notion publishing", tier: "later", via: "api" },
  { id: "confluence", name: "Confluence publishing", tier: "later", via: "api" },
];

let githubCache: { at: number; repo?: string; error?: string } | undefined;

/** The GitHub repo this project maps to, via the user's own `gh` login. */
async function githubRepo(repoPath: string): Promise<{ repo?: string; error?: string }> {
  if (githubCache && Date.now() - githubCache.at < 60_000) return githubCache;
  try {
    const { stdout } = await run(
      "gh",
      ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
      {
        cwd: repoPath,
        timeout: 10_000,
      },
    );
    githubCache = { at: Date.now(), repo: stdout.trim() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    githubCache = {
      at: Date.now(),
      error: /ENOENT/.test(message)
        ? "The gh CLI is not installed"
        : /auth|login/i.test(message)
          ? "gh is not logged in: run gh auth login"
          : "This repository has no GitHub remote",
    };
  }
  return githubCache;
}

export async function listIntegrations(repoPath: string): Promise<IntegrationEntry[]> {
  const settings = readSettings(repoPath);
  const gh = await githubRepo(repoPath);
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
              : "Off: Accept merges locally"
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
          connected: Boolean(settings.slackWebhookUrl),
          detail: settings.slackWebhookUrl ? "Webhook set" : "Not connected",
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

/** Post to the configured Slack webhook. Returns false when not connected. */
export async function notifySlack(
  repoPath: string,
  log: EventLog | undefined,
  kind: "standup" | "needs_you" | "run_report" | "test",
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  const url = readSettings(repoPath).slackWebhookUrl;
  if (!url) return { ok: false, error: "Slack is not connected" };
  let result: { ok: boolean; error?: string };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10_000),
    });
    result = res.ok ? { ok: true } : { ok: false, error: `Slack answered ${res.status}` };
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  await log
    ?.append({
      actor: "harness",
      type: PM_EVENTS.notify,
      payload: { channel: "slack", kind, ok: result.ok },
    })
    .catch(() => undefined);
  return result;
}

// --- CSV ------------------------------------------------------------------------

export function toCsv(rows: string[][]): string {
  const cell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return `${rows.map((r) => r.map(cell).join(",")).join("\r\n")}\r\n`;
}

/** RFC 4180 CSV: quoted fields, doubled quotes, newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

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

export function exportBoard(
  cards: CardRecord[],
  cycles: { id: string; name: string }[],
  format: ExportFormat,
): { body: string; contentType: string; ext: string } {
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
        (c.labels ?? []).join(" "),
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
        (c.labels ?? []).join(","),
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
      labels: [
        ...(c.labels ?? []),
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
    body: `${JSON.stringify({ cards, cycles }, null, 2)}\n`,
    contentType: "application/json",
    ext: "json",
  };
}

const pickPriority = (value: string): number | undefined => {
  const v = value.trim().toLowerCase();
  if (!v) return undefined;
  if (v === "highest" || v === "urgent" || v === "blocker" || v === "critical") return 1;
  if (v === "high" || v === "major") return 2;
  if (v === "medium" || v === "normal") return 3;
  if (v === "low" || v === "lowest" || v === "minor" || v === "trivial") return 4;
  if (v === "no priority" || v === "none") return 0;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 4 ? n : undefined;
};

/**
 * Parse another tool's export into card drafts.
 *
 * Column names are matched loosely (Jira calls it Summary, Linear calls it
 * Title), so a CSV from either tool, or a hand-made one, imports without a
 * mapping step. Nothing is created here: the drafts become proposals.
 */
export function importDrafts(format: string, content: string): ProposalDraft[] {
  type Fields = Record<string, unknown>;
  const drafts: Fields[] = [];
  if (format === "jira-csv" || format === "linear-csv" || format === "csv") {
    const [header, ...rows] = parseCsv(content);
    if (!header) return [];
    const col = (...names: string[]) =>
      header.findIndex((h) => names.includes(h.trim().toLowerCase()));
    const title = col("summary", "title", "name");
    const desc = col("description", "body");
    const prio = col("priority");
    const est = col("story points", "estimate", "points", "custom field (story points)");
    const labels = col("labels", "label");
    const due = col("due date", "duedate", "due");
    if (title < 0) return [];
    for (const r of rows) {
      const t = r[title]?.trim();
      if (!t) continue;
      const p = prio >= 0 ? pickPriority(r[prio] ?? "") : undefined;
      const e = est >= 0 ? Number(r[est]) : Number.NaN;
      const l = labels >= 0 ? (r[labels] ?? "").split(/[,\s]+/).filter(Boolean) : [];
      const d = due >= 0 ? (r[due] ?? "").trim() : "";
      drafts.push({
        title: t.slice(0, 300),
        ...(desc >= 0 && r[desc]?.trim() ? { spec: r[desc]?.trim() } : {}),
        ...(p !== undefined ? { priority: p } : {}),
        ...(Number.isFinite(e) && e > 0 ? { estimate: e } : {}),
        ...(l.length ? { labels: l } : {}),
        ...(/^\d{4}-\d{2}-\d{2}/.test(d) ? { dueDate: d.slice(0, 10) } : {}),
      });
    }
  } else if (format === "github-json" || format === "json") {
    const parsed = JSON.parse(content) as unknown;
    const list = Array.isArray(parsed) ? parsed : ((parsed as { cards?: unknown[] }).cards ?? []);
    for (const item of list as Record<string, unknown>[]) {
      const t = typeof item.title === "string" ? item.title.trim() : "";
      if (!t) continue;
      const labelNames = Array.isArray(item.labels)
        ? item.labels
            .map((l) => (typeof l === "string" ? l : String((l as { name?: string }).name ?? "")))
            .filter(Boolean)
        : [];
      const prioLabel = labelNames.find((l) => l.startsWith("priority:"));
      const p = prioLabel
        ? pickPriority(prioLabel.slice(9))
        : pickPriority(String(item.priority ?? ""));
      drafts.push({
        title: t.slice(0, 300),
        ...(typeof item.body === "string" && item.body.trim() ? { spec: item.body.trim() } : {}),
        ...(typeof item.spec === "string" ? { spec: item.spec } : {}),
        ...(p !== undefined ? { priority: p } : {}),
        ...(labelNames.filter((l) => !l.includes(":")).length
          ? { labels: labelNames.filter((l) => !l.includes(":")) }
          : {}),
      });
    }
  }
  return drafts.map((fields) => ({
    kind: "create_card" as const,
    cards: [fields],
    summary: `Import ${String(fields.title)}`,
  }));
}

// --- GitHub sync ----------------------------------------------------------------

interface GhIssue {
  number: number;
  title: string;
  body: string;
  state: string;
  url: string;
  labels: { name: string }[];
}

/**
 * Two-way sync with GitHub Issues via the user's own `gh` login.
 *
 * Pull creates a Backlog card for each open issue not yet linked; push opens
 * an issue for each unlinked card and closes or reopens linked issues to match
 * Done. Titles and bodies are not overwritten in either direction: a sync must
 * never destroy an edit someone made on the other side.
 */
export async function syncGithub(
  repoPath: string,
  cardStore: CardStore,
  direction: "pull" | "push" | "both",
  eventLog?: EventLog,
): Promise<{ created: number; updated: number; skipped: number; errors: string[] }> {
  const out = { created: 0, updated: 0, skipped: 0, errors: [] as string[] };
  // The GitHub App or Forgejo adapter when configured (Y10-Y12, Y20): last-
  // writer-wins with history, and mid-card scope edits pause the card.
  const adapter = trackerFromEnv(githubAppFromEnv());
  if (adapter && eventLog) {
    const since = readSettings(repoPath).lastSync?.[adapter.system] ?? "1970-01-01T00:00:00Z";
    const r = await syncViaAdapter(adapter, cardStore, eventLog, since);
    writeSettings(repoPath, {
      lastSync: { ...(readSettings(repoPath).lastSync ?? {}), [adapter.system]: new Date().toISOString() },
    });
    return { created: r.created + r.pushed, updated: r.updated + r.paused, skipped: 0, errors: r.errors };
  }
  const gh = await githubRepo(repoPath);
  if (!gh.repo) {
    out.errors.push(gh.error ?? "No GitHub repository");
    return out;
  }
  const cards = await cardStore.listCards();
  const linked = new Map(
    cards
      .filter((c) => c.externalRef?.system === "github")
      .map((c) => [String(c.externalRef?.id), c]),
  );

  if (direction === "pull" || direction === "both") {
    try {
      const { stdout } = await run(
        "gh",
        [
          "issue",
          "list",
          "--state",
          "open",
          "--limit",
          "200",
          "--json",
          "number,title,body,state,url,labels",
        ],
        { cwd: repoPath, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
      );
      for (const issue of JSON.parse(stdout) as GhIssue[]) {
        const key = `${gh.repo}#${issue.number}`;
        if (linked.has(key)) {
          out.skipped++;
          continue;
        }
        const labels = issue.labels.map((l) => l.name);
        const prio = labels.find((l) => l.startsWith("priority:"));
        const priority = prio ? pickPriority(prio.slice(9)) : undefined;
        await cardStore.createCard(
          {
            tier: "task",
            title: issue.title.slice(0, 300),
            status: "backlog",
            ...(issue.body?.trim() ? { spec: issue.body.trim() } : {}),
            labels: labels.filter((l) => !l.includes(":")),
            ...(priority !== undefined ? { priority } : {}),
            externalRef: { system: "github", id: key, url: issue.url },
          },
          "github",
        );
        out.created++;
      }
    } catch (err) {
      out.errors.push(`pull: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (direction === "push" || direction === "both") {
    for (const card of await cardStore.listCards()) {
      if (card.tier === "epic") continue;
      const ref = card.externalRef?.system === "github" ? String(card.externalRef.id) : undefined;
      try {
        if (!ref) {
          if (card.status === "done" || card.status === "rejected") {
            out.skipped++;
            continue;
          }
          const { stdout } = await run(
            "gh",
            [
              "issue",
              "create",
              "--title",
              cleanTitle(card.title),
              "--body",
              `${card.spec ?? ""}\n\n_Tracked by Sekhemet as \`${card.id}\`._`,
            ],
            { cwd: repoPath, timeout: 30_000 },
          );
          const url = stdout.trim().split("\n").at(-1) ?? "";
          const number = url.split("/").at(-1);
          await cardStore.updateCard(
            card.id,
            { externalRef: { system: "github", id: `${gh.repo}#${number}`, url } },
            "github",
          );
          out.created++;
        } else {
          const number = ref.split("#").at(-1) ?? "";
          const closed = card.status === "done" || card.status === "rejected";
          const { stdout } = await run(
            "gh",
            ["issue", "view", number, "--json", "state", "-q", ".state"],
            {
              cwd: repoPath,
              timeout: 15_000,
            },
          );
          const isClosed = stdout.trim() === "CLOSED";
          if (closed !== isClosed) {
            await run("gh", ["issue", closed ? "close" : "reopen", number], {
              cwd: repoPath,
              timeout: 15_000,
            });
            out.updated++;
          } else out.skipped++;
        }
      } catch (err) {
        out.errors.push(`${card.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  writeSettings(repoPath, {
    lastSync: { ...(readSettings(repoPath).lastSync ?? {}), github: new Date().toISOString() },
  });
  return out;
}

// --- Routes ---------------------------------------------------------------------

export interface IntegrationsContext {
  repoPath: string;
  log: EventLog;
  cardStore?: CardStore;
  pmStore: PmStore;
  json: (res: ServerResponse, status: number, body: unknown) => void;
  readJsonBody: (req: IncomingMessage, limit?: number) => Promise<Record<string, unknown>>;
  mutationGuard: (req: IncomingMessage, res: ServerResponse) => CardStore | undefined;
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
      writeSettings(ctx.repoPath, { slackWebhookUrl: undefined });
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
    const out = exportBoard(await ctx.cardStore.listCards(), await ctx.pmStore.cycles(), format);
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
      drafts = importDrafts(format, content);
    } catch (err) {
      ctx.json(res, 400, {
        error: `Could not read that file: ${err instanceof Error ? err.message : String(err)}`,
      });
      return true;
    }
    if (drafts.length === 0) {
      ctx.json(res, 400, { error: "No cards found. The file needs a Summary or Title column." });
      return true;
    }
    // Stored as a PM message so each import proposal is applied or discarded
    // through exactly the same flow as the PM's own.
    const reply = await ctx.pmStore.appendReply({
      replyTo: [],
      text: `Import preview: ${drafts.length} card${drafts.length === 1 ? "" : "s"} from ${format}. Apply the ones you want.`,
      proposals: drafts.slice(0, 500),
    });
    ctx.json(res, 200, { proposals: reply.proposals ?? [], messageId: reply.id });
    return true;
  }

  return false;
}
