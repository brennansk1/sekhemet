import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, join } from "node:path";
import type { BoardService } from "@sekhemet/board";
import { DeterministicGateRunner, loadGatesConfig } from "@sekhemet/gates";
import type { CardStore, CardTier, EventLog } from "@sekhemet/kernel";
import { ProcessSandbox } from "@sekhemet/sandbox";
import { applyProposal } from "./pm/apply.js";
import { runnerLease } from "./pm/service.js";
import { PmStore } from "./pm/store.js";

/**
 * The rest of the REST API the design specifies (H12), so the dashboard, the
 * SDK and editors can start work, not just watch it:
 *
 *   GET  /api/workspace                 the workspace and its projects
 *   GET  /api/projects/:id/board        one project's cards
 *   POST /api/projects/:id/cards        create a card in a project
 *   POST /api/cards/:id/split           split into ordered parts (original parked)
 *   POST /api/cards/:id/run             start the card in a background process
 *   POST /api/cards/:id/gate            run gates in the card's worktree
 *   GET  /api/cards/:id/evidence        the latest evidence bundle
 *   POST /api/machine/calibrate         re-measure the machine in the background
 *
 * Runs and calibration start a separate `sekhemet` process: the dashboard
 * server never holds model weights, and a run that crashes cannot take the
 * dashboard down with it. Writes require the same trusted-mutation check as
 * every other write.
 */

export interface RestExtraContext {
  repoPath: string;
  cardStore?: CardStore | undefined;
  boardService: BoardService;
  log: EventLog;
  json: (res: ServerResponse, status: number, body: unknown) => void;
  readJsonBody: (req: IncomingMessage) => Promise<Record<string, unknown>>;
  trusted: (req: IncomingMessage) => boolean;
  /** Starts `sekhemet <args>` detached; returns its pid. Injectable for tests. */
  launch?: (args: string[]) => number;
}

const CARD = "card_[A-Za-z0-9_-]+";
const TIERS = new Set(["initiative", "epic", "feature", "story", "task"]);

function defaultLaunch(args: string[]): number {
  // SEKHEMET_CLI names the CLI entry when this server was not started by it.
  const cli = process.env.SEKHEMET_CLI ?? process.argv[1] ?? "";
  const child = spawn(process.execPath, [cli, ...args], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child.pid ?? 0;
}

function cardFields(b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of [
    "title",
    "spec",
    "priority",
    "estimate",
    "labels",
    "scopeFiles",
    "acceptanceCriteria",
    "epicId",
    "cycleId",
    "dueDate",
  ]) {
    if (b[k] !== undefined) out[k] = b[k];
  }
  return out;
}

export async function handleRestExtras(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  ctx: RestExtraContext,
): Promise<boolean> {
  const { json } = ctx;
  const store = ctx.cardStore;
  const write = req.method === "POST" || req.method === "PATCH";
  const guard = (): CardStore | undefined => {
    if (!ctx.trusted(req)) {
      json(res, 403, {
        error: "Writes must come from the dashboard, the SDK or the CLI on this machine",
      });
      return undefined;
    }
    if (!store) {
      json(res, 501, { error: "This server was started read-only" });
      return undefined;
    }
    return store;
  };

  if (url === "/api/workspace" && req.method === "GET") {
    json(res, 200, {
      workspace: { name: basename(ctx.repoPath), repoPath: ctx.repoPath },
      projects: store?.listProjects() ?? [],
    });
    return true;
  }

  const projBoard = /^\/api\/projects\/(proj_[A-Za-z0-9_-]+)\/board$/.exec(url);
  if (projBoard && req.method === "GET") {
    const cards = (await store?.listCards()) ?? [];
    json(res, 200, {
      board: {
        projectId: projBoard[1],
        cards: cards.filter((c) => (c as { projectId?: string }).projectId === projBoard[1]),
      },
    });
    return true;
  }

  const projCards = /^\/api\/projects\/(proj_[A-Za-z0-9_-]+)\/cards$/.exec(url);
  if (projCards && write) {
    const s = guard();
    if (!s) return true;
    const b = await ctx.readJsonBody(req);
    const title = typeof b.title === "string" ? b.title.trim() : "";
    if (!title) {
      json(res, 400, { error: "A card needs a title" });
      return true;
    }
    const tier = TIERS.has(String(b.tier)) ? (b.tier as CardTier) : "task";
    const card = await s.createCard(
      { ...cardFields(b), title, tier, status: "backlog", projectId: projCards[1] } as never,
      "human",
    );
    json(res, 201, { card });
    return true;
  }

  const evidence = new RegExp(`^/api/cards/(${CARD})/evidence$`).exec(url);
  if (evidence && req.method === "GET") {
    const path = join(ctx.repoPath, ".sekhemet", "evidence", `latest-${evidence[1]}.json`);
    if (!existsSync(path)) {
      json(res, 404, { error: `No evidence for ${evidence[1]} yet` });
      return true;
    }
    json(res, 200, { evidence: JSON.parse(readFileSync(path, "utf8")) });
    return true;
  }

  const action = new RegExp(`^/api/cards/(${CARD})/(split|run|gate)$`).exec(url);
  if (action && write) {
    const s = guard();
    if (!s) return true;
    const [, cardId, verb] = action as unknown as [string, string, string];
    const card = await s.getCard(cardId);
    if (!card) {
      json(res, 404, { error: `No card ${cardId}` });
      return true;
    }
    const b = await ctx.readJsonBody(req);

    if (verb === "split") {
      const parts = Array.isArray(b.parts) ? (b.parts as Record<string, unknown>[]) : [];
      if (parts.length < 2 || parts.some((p) => typeof p.title !== "string" || !p.title)) {
        json(res, 400, { error: "A split needs at least two parts, each with a title" });
        return true;
      }
      const pmStore = new PmStore(ctx.log);
      const r = await applyProposal(
        {
          id: `rest_split_${Date.now().toString(36)}`,
          kind: "split_card",
          summary: `Split ${cardId} into ${parts.length} parts`,
          cardId,
          cards: parts.map(cardFields),
          state: "open",
        },
        { cardStore: s, boardService: ctx.boardService, pmStore, actor: "human" },
      );
      json(res, 200, { subtasks: r.cards.filter((c) => c.id !== cardId) });
      return true;
    }

    if (verb === "run") {
      const lease = runnerLease(ctx.repoPath);
      if (lease) {
        json(res, 409, {
          error: `A queue is already running here (pid ${(lease as { pid?: number }).pid ?? "?"}); the card will be picked up if it is Ready.`,
        });
        return true;
      }
      const args = ["run", cardId, "--repo", ctx.repoPath];
      const pid = (ctx.launch ?? defaultLaunch)(args);
      json(res, 202, { started: true, pid, cardId });
      return true;
    }

    // gate
    const wt = join(ctx.repoPath, ".sekhemet", "worktrees", cardId);
    const cwd = existsSync(wt) ? wt : ctx.repoPath;
    const cfg = loadGatesConfig(ctx.repoPath);
    const wanted = Array.isArray(b.gates) ? (b.gates as unknown[]).map(String) : undefined;
    const gates = wanted
      ? cfg.gates.filter((g) => wanted.includes(g.id) || wanted.includes(g.rung))
      : cfg.gates;
    const runner = new DeterministicGateRunner(new ProcessSandbox(), {
      repoRoot: ctx.repoPath,
      expectedConfigSha256: cfg.sha256,
    });
    const result = await runner.runGates([...new Set(gates.map((g) => g.rung))], cwd);
    json(res, 200, {
      cwd,
      passed: result.passed,
      results: result.rungResults,
      failures: result.failures.map((f) => ({
        gate: f.gate,
        excerpt: f.errorExcerpt,
        fix: f.suggestedAction,
      })),
    });
    return true;
  }

  if (url === "/api/machine/calibrate" && req.method === "POST") {
    if (!ctx.trusted(req)) {
      json(res, 403, { error: "Writes must come from this machine" });
      return true;
    }
    const b = await ctx.readJsonBody(req);
    const models = typeof b.models === "string" ? ["--models", b.models] : [];
    const pid = (ctx.launch ?? defaultLaunch)(["calibrate", "--force", ...models]);
    json(res, 202, { started: true, pid });
    return true;
  }

  return false;
}
