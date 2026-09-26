import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { BoardServiceImpl } from "@sekhemet/board";
import type { CardStore, EventLog } from "@sekhemet/kernel";
import {
  DecisionStore,
  GoalStore,
  computeSignals,
  diagnoseEscalation,
  reviewSession,
  standupReport,
} from "@sekhemet/planner";
import {
  DELEGATE_LABEL,
  type FetchLike,
  type GitHubClient,
  NodeGitSyncAdapter,
  type WebhookIntent,
  githubWebhookHandler,
} from "@sekhemet/sync";
import { suggestedAccepters } from "./codeowners.js";
import {
  appClientFromEnv,
  appJwtClientFromEnv,
  egressRecorder,
  githubEndpoints,
  integrationFetch,
} from "./github_transport.js";
import { readSettings, syncGithub, writeSettings } from "./integrations.js";
import {
  DEPENDENCY_LABEL,
  findLinkedCard,
  mirrorAgentStatuses,
  recordDoneBeforeAccept,
  recordSnapshot,
  subIssuesLabel,
} from "./wave2_github.js";

/**
 * Dashboard routes for the planner and sync wiring (wave 2, Builder C):
 *   GET  /api/planner/decisions            planner decisions with options (P9)
 *   POST /api/planner/decisions/:id        answer; the card resumes (P11)
 *   GET  /api/goals                        goals and their criteria (P17-P22)
 *   GET  /api/standup                      status from gates and the log (P13)
 *   GET  /api/signals                      the seven live signals (P20)
 *   GET  /api/cards/:id/diff               structural, intent-grouped diff (Y8)
 *   GET  /api/cards/:id/review             review brief (P12) and escalation (P14)
 *   POST /webhooks/github                  signed GitHub App events (Y13)
 */
export interface Wave2RouteContext {
  repoPath: string;
  cardStore?: CardStore;
  log: EventLog;
  json: (res: ServerResponse, status: number, body: unknown) => void;
  isTrustedMutation: (req: IncomingMessage) => boolean;
  readJsonBody: (req: IncomingMessage) => Promise<Record<string, unknown>>;
  /** Injectable for tests. */
  webhookSecret?: string;
  /**
   * How often, at most, a delivery's arrival reads the App's delivery log for
   * a gap (INT-11b); default ten minutes.
   */
  gapCheckEveryMs?: number;
  env?: NodeJS.ProcessEnv;
}

const CARD = "[A-Za-z0-9_.:-]+";

/** The GitHub App client from the environment, when configured (integrations item 10). */
export function githubAppFromEnv(
  env: NodeJS.ProcessEnv,
  /** The network policy's fetch (`integrationFetch`): required, never the global one. */
  fetchImpl: FetchLike,
): GitHubClient | undefined {
  return appClientFromEnv(fetchImpl, env);
}

/**
 * The claim on a webhook delivery (integrations item 12, INT-9): each
 * `X-GitHub-Delivery` is processed at most once, across restarts — the
 * processed ids are on the ledger as `github/delivery` events whose event id
 * is derived from the delivery id, and an in-flight set closes the window
 * between the check and the record.
 */
const inFlight = new Set<string>();
const deliveryEventId = (delivery: string) =>
  `ghd_${createHash("sha256").update(delivery).digest("hex").slice(0, 32)}`;

export function claimDelivery(log: EventLog, delivery: string): boolean {
  const id = deliveryEventId(delivery);
  if (inFlight.has(id) || log.hasEvent(id)) return false;
  inFlight.add(id);
  return true;
}

/** Record a claimed delivery as processed, or release it when processing failed. */
export async function settleDelivery(
  log: EventLog,
  delivery: string,
  processed: { intent: string } | undefined,
): Promise<void> {
  const id = deliveryEventId(delivery);
  try {
    if (processed) {
      await log.append({
        id,
        actor: "github",
        type: "github/delivery",
        payload: { delivery, intent: processed.intent },
      });
    }
  } finally {
    inFlight.delete(id);
  }
}

/** `owner/repo` of a pull request's URL (`card/pr_opened`'s `url`), lower-cased. */
function pullRequestRepo(url: string | undefined): string | undefined {
  const m = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/\d+/.exec(url ?? "");
  return m?.[1]?.toLowerCase();
}

/** Act on a verified webhook intent: new cards, review cards, a pull request's close. */
export async function applyWebhookIntent(
  store: CardStore,
  intent: WebhookIntent,
  _delivery: string,
): Promise<string | undefined> {
  const idOf = (prefix: string, n: number) => `card_${prefix}${n}`;
  switch (intent.kind) {
    case "create_card": {
      // INT-1: one card per issue, found by its one identity on every path.
      const linked = await findLinkedCard(store, intent.ref);
      if (linked) return linked.id;
      const owner = intent.assignee
        ? store.principalForHandle("github", intent.assignee)
        : undefined;
      // The issue's labels as the tracker holds them (M2); the delegate label
      // is the Worker's, not a label, and the sub-issues note is the board's.
      const labels = intent.labels.filter((l) => l !== DELEGATE_LABEL);
      const card = await store.createCard(
        {
          tier: "story",
          title: intent.title.slice(0, 300),
          status: "backlog",
          // As written: a linked card's text is tagged untrusted where it
          // reaches a prompt (S9, the loop's goal).
          ...(intent.body.trim() ? { spec: intent.body.trim() } : {}),
          externalRef: intent.ref,
          labels: [
            ...labels,
            ...(intent.subIssues.length ? [subIssuesLabel(intent.subIssues)] : []),
          ],
        },
        "github",
      );
      if (owner) await store.changeOwner(card.id, owner, undefined, "github");
      // The agreed state, so the next sync of this issue changes nothing (INT-3).
      await recordSnapshot(store, await store.getCard(card.id), {
        ref: intent.ref,
        title: intent.title,
        body: intent.body.trim(),
        labels,
        delegatedToWorker: intent.labels.includes(DELEGATE_LABEL),
        ...(intent.assignee ? { assignee: intent.assignee } : {}),
        state: "open",
        updatedAt: intent.updatedAt ?? "",
      });
      return card.id;
    }
    case "external_review":
    case "verify_dependency_pr": {
      const id = idOf(intent.kind === "external_review" ? "review" : "deps", intent.pr);
      if (await store.getCard(id)) return id;
      // Linked to its pull request (INT-16a), so no sync opens an issue for it.
      const url = intent.url ?? "";
      await store.createCard(
        {
          id,
          tier: "task",
          title:
            intent.kind === "external_review"
              ? `Review PR #${intent.pr}`
              : `Verify ${intent.author} PR #${intent.pr}`,
          status: "ready",
          spec: `Run the full gates against PR #${intent.pr} at ${intent.headSha || "its head"} and report.`,
          labels: [intent.kind === "external_review" ? "external-review" : DEPENDENCY_LABEL],
          ...(url || intent.kind === "external_review"
            ? { externalRef: { system: "github" as const, id: `pr/${intent.pr}`, url } }
            : {}),
        },
        "github",
      );
      return id;
    }
    case "issue_closed": {
      // INT-20c: the tracker's Done never moves the board; closed early, it is recorded.
      const card = await findLinkedCard(store, intent.ref);
      if (!card) return undefined;
      const at = intent.closedAt ?? new Date().toISOString();
      await recordDoneBeforeAccept(store, card, at, "github");
      return card.id;
    }
    case "pull_request_closed": {
      // Kernel rule 24 (K-N3-4): the accepted card awaiting this pull request
      // moves to Done on a merge, or waits in Review again when it closed
      // unmerged — with the merge commit and who closed it (INT-13, INT-14).
      // Matched by repository and number (M3): the same number in another
      // repository is another pull request.
      const card = (await store.listCards({ status: "review" })).find(
        (c) =>
          c.hold?.kind === "awaitingMerge" &&
          c.hold.pr === intent.pr &&
          intent.repo !== undefined &&
          pullRequestRepo(c.hold.url) === intent.repo.toLowerCase(),
      );
      if (!card) return undefined;
      const closer = intent.closedBy
        ? store.principalForHandle("github", intent.closedBy)
        : undefined;
      await new BoardServiceImpl(store, { entryConditions: true }).closePullRequest(
        card.id,
        {
          pr: intent.pr,
          merged: intent.merged,
          ...(intent.mergeCommit ? { mergeCommit: intent.mergeCommit } : {}),
          ...(closer ? { closedBy: closer } : {}),
          ...(intent.closedBy && !closer ? { closedByHandle: intent.closedBy } : {}),
        },
        "github",
      );
      return card.id;
    }
    default:
      return undefined;
  }
}

export async function handleWave2Route(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  ctx: Wave2RouteContext,
): Promise<boolean> {
  const { json, cardStore } = ctx;
  if (url === "/webhooks/github" && req.method === "POST") {
    const secret = ctx.webhookSecret ?? process.env.SEKHEMET_GITHUB_WEBHOOK_SECRET;
    if (!secret || !cardStore) {
      json(res, 503, {
        error: "GitHub webhooks are not configured (SEKHEMET_GITHUB_WEBHOOK_SECRET)",
      });
      return true;
    }
    githubWebhookHandler({
      secret,
      claimDelivery: (delivery) => claimDelivery(ctx.log, delivery),
      onIntent: async (intent, delivery) => {
        let done: { intent: string } | undefined;
        try {
          await applyWebhookIntent(cardStore, intent, delivery);
          done = { intent: intent.kind };
        } finally {
          if (delivery) await settleDelivery(ctx.log, delivery, done);
        }
      },
      // INT-11b: a delivery's arrival, not a timer, is when the delivery log is read.
      afterDelivery: () => {
        void checkGapsAfterDelivery(ctx.repoPath, cardStore, ctx.log, {
          everyMs: ctx.gapCheckEveryMs ?? 600_000,
          env: ctx.env ?? process.env,
        });
      },
    })(req, res);
    return true;
  }
  if (!cardStore) return false;
  const ledger = { store: cardStore, log: ctx.log };

  // U8: visual gate images (baselines, captures, candidates) for Review.
  const visual = /^\/api\/visual\/(baselines|actual|candidates)\/([\w.@-]+\.png)$/.exec(url);
  if (visual && req.method === "GET") {
    const { existsSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const path = join(
      ctx.repoPath,
      ".sekhemet",
      "visual",
      visual[1] as string,
      visual[2] as string,
    );
    if (!existsSync(path)) json(res, 404, { error: "no such image" });
    else {
      res.writeHead(200, { "content-type": "image/png", "cache-control": "no-cache" });
      res.end(readFileSync(path));
    }
    return true;
  }
  // U18: per-step model telemetry for the Machine view's sparklines.
  if (url === "/api/telemetry" && req.method === "GET") {
    const steps = (await ctx.log.getEventsByTypes(["card/step"])).slice(-240);
    const points = steps.flatMap((e) => {
      const u = (e.payload as { usage?: Record<string, number> }).usage;
      if (!u) return [];
      return [
        {
          seq: e.seq,
          at: e.createdAt,
          cardId: e.cardId,
          ...(u.decodeTokensPerSecond !== undefined ? { decode: u.decodeTokensPerSecond } : {}),
          ...(u.prefillTokensPerSecond !== undefined ? { prefill: u.prefillTokensPerSecond } : {}),
          ...(u.cacheHitRate !== undefined ? { cacheHit: u.cacheHitRate } : {}),
          ...(u.promptTokens !== undefined ? { promptTokens: u.promptTokens } : {}),
        },
      ];
    });
    json(res, 200, { steps: points });
    return true;
  }
  // U7: the model registry and the bake-off records, for the Registry view.
  if (url === "/api/registry" && req.method === "GET") {
    const { ModelRegistry, readBakeOffRecords } = await import("@sekhemet/models");
    const { join } = await import("node:path");
    let bakeoff: unknown[] = [];
    try {
      bakeoff = readBakeOffRecords(join(ctx.repoPath, ".sekhemet", "bakeoff", "records.jsonl"));
    } catch {
      bakeoff = [];
    }
    json(res, 200, { models: new ModelRegistry().list(), bakeoff });
    return true;
  }

  // X16: recurring templates, and webhook triggers from the dashboard or from
  // a caller holding SEKHEMET_TRIGGER_TOKEN (CI, a docs build, a cron job).
  if (url === "/api/recurring" && req.method === "GET") {
    const { nextRun, scheduleOf } = await import("./recurring.js");
    const templates = [];
    for (const c of await cardStore.listCards()) {
      const s = scheduleOf(c);
      if (!s) continue;
      const next = s.cron ? nextRun(s.cron, new Date())?.toISOString() : undefined;
      templates.push({ id: c.id, title: c.title, ...s, ...(next ? { next } : {}) });
    }
    json(res, 200, { templates });
    return true;
  }
  const trigger = /^\/api\/recurring\/trigger\/([\w.-]+)$/.exec(url);
  if (trigger && req.method === "POST") {
    const token = process.env.SEKHEMET_TRIGGER_TOKEN;
    const bearer = tokenMatches(req.headers.authorization, token);
    if (!ctx.isTrustedMutation(req) && !(token && bearer)) {
      json(res, 403, { error: "Triggers need the dashboard or SEKHEMET_TRIGGER_TOKEN" });
      return true;
    }
    const { fireTrigger } = await import("./recurring.js");
    await fireTrigger(ctx.log, trigger[1] as string, { by: bearer ? "token" : "dashboard" });
    json(res, 202, { fired: trigger[1] });
    return true;
  }

  if (url === "/api/planner/decisions" && req.method === "GET") {
    json(res, 200, { decisions: await new DecisionStore(ledger).all() });
    return true;
  }
  const answer = /^\/api\/planner\/decisions\/(dec_[A-Za-z0-9_-]+)$/.exec(url);
  if (answer && req.method === "POST") {
    if (!ctx.isTrustedMutation(req)) {
      json(res, 403, { error: "Decisions must come from the dashboard itself" });
      return true;
    }
    try {
      const body = await ctx.readJsonBody(req);
      const d = await new DecisionStore(ledger).answer(
        answer[1] as string,
        Number(body.option),
        "human",
      );
      json(res, 200, { decision: d });
    } catch (err) {
      json(res, 409, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }
  if (url === "/api/goals" && req.method === "GET") {
    json(res, 200, { goals: await new GoalStore(ledger).all() });
    return true;
  }
  if (url === "/api/standup" && req.method === "GET") {
    json(res, 200, await standupReport(ledger));
    return true;
  }
  if (url === "/api/signals" && req.method === "GET") {
    const events = await ctx.log.getEventsByTypes([
      "card/status_changed",
      "gate/result",
      "assumption/logged",
      "assumption/outcome",
    ]);
    json(res, 200, {
      signals: computeSignals({
        now: new Date(),
        cards: await cardStore.listCards(),
        events,
        reviewWip: 3,
      }),
    });
    return true;
  }
  // X3: images on a card (screenshots, mockups, diagrams).
  const attach = new RegExp(`^/api/cards/(${CARD})/attachments(?:/([0-9a-f]{12}))?$`).exec(url);
  if (attach) {
    const { attachImage, listAttachments, readAttachment } = await import("./attachments.js");
    const cardId = attach[1] as string;
    if (req.method === "GET" && attach[2]) {
      const hit = readAttachment(ctx.repoPath, cardId, attach[2]);
      if (!hit) json(res, 404, { error: "no such attachment" });
      else {
        res.writeHead(200, {
          "content-type": hit.attachment.mime,
          "cache-control": "private, max-age=86400",
          "x-content-type-options": "nosniff",
        });
        res.end(hit.bytes);
      }
      return true;
    }
    if (req.method === "GET") {
      json(res, 200, { attachments: listAttachments(ctx.repoPath, cardId) });
      return true;
    }
    if (req.method === "POST" && !attach[2]) {
      if (!ctx.isTrustedMutation(req)) {
        json(res, 403, { error: "Attachments must come from the dashboard itself" });
        return true;
      }
      try {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const c of req) {
          size += (c as Buffer).length;
          if (size > 15 * 1024 * 1024) throw new Error("image too large (10 MB at most)");
          chunks.push(c as Buffer);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          name?: string;
          data?: string;
        };
        const data = String(body.data ?? "").replace(/^data:[^;]+;base64,/, "");
        const a = await attachImage(ctx.repoPath, cardStore, cardId, {
          name: String(body.name ?? "image"),
          bytes: Buffer.from(data, "base64"),
        });
        json(res, 201, { attachment: a });
      } catch (err) {
        json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }
  }
  const diff = new RegExp(`^/api/cards/(${CARD})/diff$`).exec(url);
  if (diff && req.method === "GET") {
    try {
      json(res, 200, await new NodeGitSyncAdapter(ctx.repoPath).structuralDiff(diff[1] as string));
    } catch (err) {
      json(res, 404, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }
  const review = new RegExp(`^/api/cards/(${CARD})/review$`).exec(url);
  if (review && req.method === "GET") {
    const id = review[1] as string;
    const card = await cardStore.getCard(id);
    if (!card) {
      json(res, 404, { error: `Card not found: ${id}` });
      return true;
    }
    const brief = await reviewSession(ledger, id);
    const escalation =
      card.status === "parked" || card.stopReason
        ? diagnoseEscalation(
            card,
            await cardStore.cardEvents(id, ["gate/result", "card/step", "attempt/started"]),
          )
        : undefined;
    json(res, 200, {
      review: brief,
      ...(escalation ? { escalation } : {}),
      // RG-N5-3: who should look, from CODEOWNERS.
      suggestedAccepters: suggestedAccepters(ctx.repoPath, cardStore, card),
    });
    return true;
  }
  return false;
}

// ------------------------------------------------ INT-11b: webhooks first

/** The webhook route is configured: its secret is set (integrations item 12). */
export const webhookRouteConfigured = (env: NodeJS.ProcessEnv = process.env): boolean =>
  Boolean(env.SEKHEMET_GITHUB_WEBHOOK_SECRET);

/** Where the delivery log was last read to, beside the sync's own `since`. */
const DELIVERIES_KEY = "github:deliveries";

/**
 * A pull that catches up (integrations item 11a, INT-11b): after a restart,
 * or a gap the App's delivery log shows. It takes the tracker's changes and
 * sends nothing, from where the last sync left off; only a project that has
 * synced before is caught up — a first pull is a person's to ask for.
 */
export async function catchUpGithub(
  repoPath: string,
  store: CardStore,
  log: EventLog,
  reason: "restart" | "gap",
  gaps = 0,
): Promise<{ ran: boolean; why?: string; errors?: string[] }> {
  if (!readSettings(repoPath).lastSync?.github) {
    return { ran: false, why: "never synced: a first pull is a person's to ask for" };
  }
  const started = new Date().toISOString();
  const r = await syncGithub(repoPath, store, "pull", log);
  if (r.errors.length === 0) {
    writeSettings(repoPath, {
      lastSync: { ...(readSettings(repoPath).lastSync ?? {}), [DELIVERIES_KEY]: started },
    });
  }
  await log.append({
    actor: "github",
    type: "github/catch_up",
    payload: { reason, gaps, created: r.created, updated: r.updated, errors: r.errors.length },
  });
  return { ran: true, errors: r.errors };
}

interface Delivery {
  guid: string;
  delivered_at: string;
  status_code: number;
  redelivery?: boolean;
}

/**
 * A gap in webhook deliveries (INT-11b). GitHub's delivery ids are GUIDs, so
 * a missed one is visible only in the App's delivery log
 * (`GET /app/hook/deliveries`, read with the App's JWT): a delivery since the
 * last check that no attempt delivered (no 2xx) is a gap. On the `gh`
 * transport there is no such log to read, and that is said plainly.
 */
export async function detectDeliveryGaps(
  repoPath: string,
  log: EventLog,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ available: boolean; reason?: string; missed: number; checkedAt: string }> {
  const checkedAt = new Date().toISOString();
  const client = appJwtClientFromEnv(
    integrationFetch(repoPath, egressRecorder(log), githubEndpoints(env).apiUrl),
    env,
  );
  if (!client) {
    return {
      available: false,
      reason:
        "On the gh transport a missed webhook delivery cannot be seen: delivery ids are GUIDs, and only a GitHub App's delivery log lists the ones that failed. A restart catches up; connect the GitHub App for gap detection.",
      missed: 0,
      checkedAt,
    };
  }
  const settings = readSettings(repoPath).lastSync ?? {};
  const since = settings[DELIVERIES_KEY] ?? settings.github;
  if (!since) return { available: true, missed: 0, checkedAt };
  const from = Date.parse(since);
  const attempts: Delivery[] = [];
  // Newest first: read pages until the log is older than the last check.
  const pages = await client.restPages<Delivery>("/app/hook/deliveries?per_page=100", 20, (page) =>
    page.some((d) => Date.parse(d.delivered_at) < from),
  );
  for (const d of pages) if (Date.parse(d.delivered_at) >= from) attempts.push(d);
  const delivered = new Set(
    attempts.filter((d) => d.status_code >= 200 && d.status_code < 300).map((d) => d.guid),
  );
  const missed = new Set(attempts.filter((d) => !delivered.has(d.guid)).map((d) => d.guid));
  return { available: true, missed: missed.size, checkedAt };
}

const lastGapCheck = new Map<string, number>();
const gapChecks = new Map<string, Promise<void>>();

/**
 * After a delivery: read the delivery log for a gap, at most once per
 * `everyMs` per project, and catch up when one shows. The checkpoint moves
 * only when the log was read and, for a gap, the catch-up succeeded.
 */
export function checkGapsAfterDelivery(
  repoPath: string,
  store: CardStore,
  log: EventLog,
  opts: { everyMs: number; env: NodeJS.ProcessEnv },
): Promise<void> {
  const now = Date.now();
  if (gapChecks.has(repoPath) || now - (lastGapCheck.get(repoPath) ?? 0) < opts.everyMs) {
    return gapChecks.get(repoPath) ?? Promise.resolve();
  }
  lastGapCheck.set(repoPath, now);
  const run = (async () => {
    try {
      const gap = await detectDeliveryGaps(repoPath, log, opts.env);
      if (!gap.available) return;
      if (gap.missed > 0) {
        await catchUpGithub(repoPath, store, log, "gap", gap.missed);
        return;
      }
      writeSettings(repoPath, {
        lastSync: { ...(readSettings(repoPath).lastSync ?? {}), [DELIVERIES_KEY]: gap.checkedAt },
      });
    } catch {
      // The log could not be read: the next delivery tries again.
      lastGapCheck.delete(repoPath);
    } finally {
      gapChecks.delete(repoPath);
    }
  })();
  gapChecks.set(repoPath, run);
  return run;
}

/**
 * The server's GitHub side (INT-11b, INT-20b). With a webhook route, one
 * catch-up pull at start for what changed while the server was down — and no
 * timer ever pulls the tracker after it. A tail of the local ledger shows a
 * linked card's moves on its issue's Projects status; it asks GitHub only
 * when a card's state changed.
 */
export function startGithubSync(
  repoPath: string,
  store: CardStore,
  log: EventLog,
  opts: { env?: NodeJS.ProcessEnv; mirrorEveryMs?: number; say?: (line: string) => void } = {},
): { started: Promise<void>; stop: () => void } {
  const env = opts.env ?? process.env;
  const started = (async () => {
    if (!webhookRouteConfigured(env)) return;
    try {
      const r = await catchUpGithub(repoPath, store, log, "restart");
      if (r.ran)
        opts.say?.(
          `GitHub: caught up after the restart${r.errors?.length ? ` (${r.errors[0]})` : ""}`,
        );
    } catch (err) {
      opts.say?.(`GitHub: no catch-up (${err instanceof Error ? err.message : String(err)})`);
    }
  })();
  // The mirror reads the local ledger, never the tracker, and only once the ledger moved.
  // After a failure — a refused egress, or GitHub unreachable — it waits a
  // minute, doubling to an hour, rather than asking again on every move (and
  // recording a refusal each time); a success resets the wait.
  let seen = -1;
  let busy = false;
  let backoff = 0;
  let retryAt = 0;
  const tick = async () => {
    if (busy) return;
    const last = log.lastSeq();
    if (last === seen || Date.now() < retryAt) return;
    busy = true;
    try {
      await started;
      const r = await mirrorAgentStatuses(repoPath, store, log, { env });
      if (r.errors.length > 0) throw new Error(r.errors[0]);
      backoff = 0;
      retryAt = 0;
    } catch {
      backoff = Math.min(Math.max(backoff * 2, 60_000), 3_600_000);
      retryAt = Date.now() + backoff;
    } finally {
      // Past its own writes (the status, the egress records), so they never re-trigger it.
      seen = log.lastSeq();
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), opts.mirrorEveryMs ?? 5000);
  timer.unref?.();
  return { started, stop: () => clearInterval(timer) };
}

/**
 * The dashboard server's recurring ticker (X16): once a minute, due
 * templates clone into Ready cards. Returns a stop function.
 */
export function startRecurringTicker(
  repoPath: string,
  cardStore: CardStore,
  log: EventLog,
  opts: { everyMs?: number; hours?: string; say?: (line: string) => void } = {},
): () => void {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const { tickRecurring } = await import("./recurring.js");
      const r = await tickRecurring(repoPath, cardStore, log, {
        ...(opts.hours ? { hours: opts.hours } : {}),
      });
      for (const f of r.fired) opts.say?.(`recurring: ${f.template} -> ${f.cloneId} (${f.reason})`);
    } catch {
      // A bad template must not stop the server; the next tick tries again.
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), opts.everyMs ?? 60_000);
  timer.unref?.();
  void tick();
  return () => clearInterval(timer);
}

/**
 * SEC-37: a `Bearer` header against the trigger token, in constant time.
 * Both sides are hashed first so their lengths never leak through timing.
 */
export function tokenMatches(header: string | undefined, token: string | undefined): boolean {
  if (!token || !header) return false;
  const digest = (v: string) => createHash("sha256").update(v).digest();
  return timingSafeEqual(digest(header), digest(`Bearer ${token}`));
}
