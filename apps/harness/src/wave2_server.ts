import type { IncomingMessage, ServerResponse } from "node:http";
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
  GITHUB_DOT_COM,
  GitHubClient,
  InstallationTokenProvider,
  NodeGitSyncAdapter,
  type WebhookIntent,
  ghesEndpoints,
  githubWebhookHandler,
  loadPrivateKey,
} from "@sekhemet/sync";

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
}

const CARD = "[A-Za-z0-9_.:-]+";

/** The GitHub App client from the environment, when configured (Y12). */
export function githubAppFromEnv(env: NodeJS.ProcessEnv = process.env): GitHubClient | undefined {
  const appId = env.SEKHEMET_GITHUB_APP_ID;
  const installationId = env.SEKHEMET_GITHUB_INSTALLATION_ID;
  if (!appId || !installationId) return undefined;
  const endpoints = env.SEKHEMET_GITHUB_HOST
    ? ghesEndpoints(env.SEKHEMET_GITHUB_HOST)
    : GITHUB_DOT_COM;
  const privateKey = loadPrivateKey({
    ...(env.SEKHEMET_GITHUB_APP_KEYCHAIN
      ? { keychainService: env.SEKHEMET_GITHUB_APP_KEYCHAIN }
      : {}),
    ...(env.SEKHEMET_GITHUB_APP_KEY_PATH ? { path: env.SEKHEMET_GITHUB_APP_KEY_PATH } : {}),
  });
  return new GitHubClient(
    new InstallationTokenProvider({ appId, installationId, privateKey, endpoints }),
    endpoints,
  );
}

/** Act on a verified webhook intent: new cards, commands, review cards (Y13). */
export async function applyWebhookIntent(
  store: CardStore,
  intent: WebhookIntent,
  delivery: string,
): Promise<string | undefined> {
  const idOf = (prefix: string, n: number) => `card_${prefix}${n}`;
  switch (intent.kind) {
    case "create_card": {
      const id = idOf("gh", intent.issue);
      if (await store.getCard(id)) return id;
      await store.createCard(
        {
          id,
          tier: "story",
          title: `GitHub #${intent.issue}`,
          status: "backlog",
          spec: `${intent.title}\n\n${intent.body}`,
          externalRef: { system: "github", id: String(intent.issue), url: intent.url },
          labels: [
            "github",
            ...(intent.subIssues.length ? [`sub-issues:${intent.subIssues.join(",")}`] : []),
          ],
        },
        "github",
      );
      return id;
    }
    case "card_command": {
      const card = (await store.listCards()).find(
        (c) => c.externalRef?.system === "github" && c.externalRef.id === String(intent.issue),
      );
      if (!card) return undefined;
      await store.recordDossierEntry({
        cardId: card.id,
        kind: "note",
        text: `GitHub comment ${intent.commentId} asks for /${intent.command} ${intent.args}`,
        actor: "github",
      });
      await store.recordEvent({
        type: "github/command",
        cardId: card.id,
        actor: "github",
        payload: { ...intent, delivery },
      });
      return card.id;
    }
    case "external_review":
    case "verify_dependency_pr": {
      const id = idOf(intent.kind === "external_review" ? "review" : "deps", intent.pr);
      if (await store.getCard(id)) return id;
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
          labels: [intent.kind === "external_review" ? "external-review" : "dependency-update"],
          ...(intent.kind === "external_review"
            ? { externalRef: { system: "github" as const, id: `pr/${intent.pr}`, url: intent.url } }
            : {}),
        },
        "github",
      );
      return id;
    }
    case "enqueue_run":
      await store
        .recordEvent({
          type: "github/dispatch",
          cardId: "board",
          actor: "github",
          payload: { ...intent, delivery },
        })
        .catch(() => undefined);
      return undefined;
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
      onIntent: async (intent, delivery) => {
        await applyWebhookIntent(cardStore, intent, delivery);
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
    const path = join(ctx.repoPath, ".sekhemet", "visual", visual[1] as string, visual[2] as string);
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
    const bearer = req.headers.authorization === `Bearer ${token}`;
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
    json(res, 200, { review: brief, ...(escalation ? { escalation } : {}) });
    return true;
  }
  return false;
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
