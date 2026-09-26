import type { EventLog } from "@sekhemet/kernel";
import { egressRecorder, integrationFetch } from "./github_transport.js";
import { readSettings } from "./integrations.js";
import type { Notice, NoticeRecord, NotifyEvent } from "./notify.js";
import { PM_EVENTS } from "./pm/types.js";

/**
 * Slack, a channel of the one notifier (integrations items 20-22, INT-17 to
 * INT-20): an incoming webhook, or a bot token and a channel through
 * `chat.postMessage`. Either is a secret: from the environment
 * (`SEKHEMET_SLACK_WEBHOOK_URL`, or `SEKHEMET_SLACK_BOT_TOKEN` with
 * `SEKHEMET_SLACK_CHANNEL`) or the integration settings, whose secrets live in
 * the keychain (SEC-27a) — never in the repository or the ledger. Every post
 * goes through the one network policy (`integrationFetch`, recorded as
 * `harness/egress` with the URL's origin only, never its secret path) and is recorded as
 * `pm/notify {channel: "slack", kind, ok}`; a 4xx, Slack's own `ok: false`
 * or a timeout is `ok: false`, and the caller goes on (INT-20).
 */

export interface SlackConnection {
  /** An incoming-webhook URL, or the Web API method URL for a bot token. */
  url: string;
  mode: "webhook" | "bot";
  token?: string;
  channel?: string;
  /** The kinds Slack carries; every kind when unset. */
  events?: NotifyEvent[];
  dailyBudget?: number;
}

/** The host the policy treats as connected when Slack is (security item 33). */
const SLACK_HOOKS = "https://hooks.slack.com";
const SLACK_API = "https://slack.com/api";

export function readSlack(
  repoPath: string,
  env: NodeJS.ProcessEnv = process.env,
): SlackConnection | undefined {
  const s = readSettings(repoPath);
  const common = {
    ...(s.slackEvents ? { events: s.slackEvents } : {}),
    ...(typeof s.slackDailyBudget === "number" ? { dailyBudget: s.slackDailyBudget } : {}),
  };
  const hook = env.SEKHEMET_SLACK_WEBHOOK_URL?.trim() || s.slackWebhookUrl;
  if (hook) return { url: hook, mode: "webhook", ...common };
  const token = env.SEKHEMET_SLACK_BOT_TOKEN?.trim() || s.slackBotToken;
  const channel = env.SEKHEMET_SLACK_CHANNEL?.trim() || s.slackChannel;
  if (token && channel) {
    const api = (env.SEKHEMET_SLACK_API_URL?.trim() || SLACK_API).replace(/\/$/, "");
    return { url: `${api}/chat.postMessage`, mode: "bot", token, channel, ...common };
  }
  return undefined;
}

/** A notice as Slack text: the title in bold, then the message and the link. */
export function slackText(n: Notice): string {
  const head = n.event === "standup" || n.event === "test" ? "" : `*${n.title}*\n`;
  return `${head}${n.message}${n.click ? `\n<${n.click}|Open in Sekhemet>` : ""}`;
}

export interface SlackDeps {
  log?: EventLog | undefined;
  /** How long Slack may take before the post counts as failed; 10 s by default. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Structural fields for the `pm/notify` record: the person, the notice and its day. */
  record?: NoticeRecord;
}

/** Post one notice to Slack. `skipped` when Slack is not connected. */
export async function sendSlack(
  repoPath: string,
  n: Notice,
  deps: SlackDeps = {},
): Promise<{ ok: boolean; error?: string; skipped?: boolean }> {
  const c = readSlack(repoPath, deps.env);
  if (!c) return { ok: false, skipped: true, error: "Slack is not connected" };
  const text = slackText(n);
  const fetchImpl = integrationFetch(
    repoPath,
    // The webhook's URL is the credential: the ledger keeps its origin only (B1).
    egressRecorder(deps.log, { redactUrl: true }),
    c.mode === "bot" ? SLACK_API : SLACK_HOOKS,
    "integration:slack",
  );
  let result: { ok: boolean; error?: string };
  try {
    const res = await fetchImpl(c.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        ...(c.token ? { Authorization: `Bearer ${c.token}` } : {}),
      },
      body: JSON.stringify(c.mode === "bot" ? { channel: c.channel, text } : { text }),
      signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
    });
    if (!res.ok) result = { ok: false, error: `Slack answered ${res.status}` };
    else if (c.mode === "bot") {
      // The Web API answers 200 with `ok: false` when it refuses a post.
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      result =
        body.ok === true ? { ok: true } : { ok: false, error: `Slack: ${body.error ?? "not ok"}` };
    } else result = { ok: true };
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  await deps.log
    ?.append({
      actor: "harness",
      type: PM_EVENTS.notify,
      ...(n.cardId ? { cardId: n.cardId } : {}),
      payload: {
        channel: "slack",
        kind: n.event,
        ok: result.ok,
        ...(deps.record?.to ? { to: deps.record.to } : {}),
        ...(deps.record?.notice ? { notice: deps.record.notice } : {}),
        ...(deps.record?.day ? { day: deps.record.day } : {}),
      },
    })
    .catch(() => undefined);
  return result;
}
