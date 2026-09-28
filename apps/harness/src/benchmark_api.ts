import type { IncomingMessage, ServerResponse } from "node:http";
import { BenchmarkRefusal, type Combination, MAX_OVERNIGHT_COMBINATIONS } from "@sekhemet/eval";
import { BenchmarkNotFound, type BenchmarkService, QUICK_TIER_COPY } from "./benchmark_cmd.js";
import { CONFIG_ROUTES, type ConfigRoute } from "./config_routes.js";

/**
 * The two-tier benchmark's REST routes (PM_CONTRACT §3 *Configuration*;
 * measurement NEW-measurement-5; dashboard NEW-dashboard-6 DB-N6-9–13): the
 * rows of `config_routes.ts` whose module is `benchmark_api`. The server's
 * access table decides each route's permission (`config.manage` for every
 * change, a person's act); here a change must also come from the dashboard
 * itself. Nothing here assigns a model (DB-N6-13).
 */

export interface BenchmarkApiContext {
  service: BenchmarkService;
  json: (res: ServerResponse, status: number, body: unknown) => void;
  readJsonBody: (req: IncomingMessage, limit?: number) => Promise<Record<string, unknown>>;
  isTrustedMutation: (req: IncomingMessage) => boolean;
  /** The person a request is for (teams §2.3); recorded on the start and stop events. */
  principalOf?: (req: IncomingMessage) => string | undefined;
  /**
   * Whether the person behind a request holds `config.manage` (an Admin in
   * the Team setup; the install's person in Solo). Checked again here for
   * every change, behind the server's access table (defence in depth).
   */
  mayManage: (req: IncomingMessage) => boolean;
}

const ROUTES = CONFIG_ROUTES.filter((r) => r.module === "benchmark_api");

/**
 * Match a route on the raw path, anchored and exact, as `config_api`'s
 * `matchRoute` does and as the access table's rules read it: a trailing or
 * doubled slash or an encoded letter is not a benchmark route, so it can
 * never be served under a permission rule that did not match it. Only a
 * parameter's value is decoded. Table order: a literal before a parameter.
 */
function match(
  method: string,
  path: string,
): { route: ConfigRoute; params: Record<string, string> } | undefined {
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const names: string[] = [];
    const re = new RegExp(
      `^${route.path.replace(/:([A-Za-z]+)/g, (_m, n: string) => {
        names.push(n);
        return "([^/]+)";
      })}$`,
    );
    const m = re.exec(path);
    if (!m) continue;
    try {
      return {
        route,
        params: Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1] ?? "")])),
      };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function combinationOf(v: unknown): Combination | undefined {
  if (!v || typeof v !== "object") return undefined;
  const c = v as Record<string, unknown>;
  const s = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim() : undefined);
  const worker = s(c.worker);
  const planner = s(c.planner);
  if (!worker || !planner) return undefined;
  const reviewer = s(c.reviewer);
  const researcher = s(c.researcher);
  return {
    worker,
    planner,
    ...(reviewer ? { reviewer } : {}),
    ...(researcher ? { researcher } : {}),
  };
}

export function createBenchmarkApi(ctx: BenchmarkApiContext) {
  const svc = ctx.service;

  const refused = (res: ServerResponse, err: unknown): void => {
    if (err instanceof BenchmarkNotFound) ctx.json(res, 404, { error: err.message });
    else if (err instanceof BenchmarkRefusal)
      ctx.json(res, 409, {
        error: err.message,
        ...(err.needsGb !== undefined ? { needsGb: err.needsGb } : {}),
      });
    else ctx.json(res, 400, { error: err instanceof Error ? err.message : String(err) });
  };

  /** A combination named by id (one already benchmarked) or by its models in the query. */
  const queryCombination = async (q: URLSearchParams): Promise<Combination | undefined> => {
    const id = q.get("combination");
    if (id) {
      const known = (await svc.results()).results.find((r) => r.combinationId === id);
      return known?.combination;
    }
    return combinationOf(Object.fromEntries(q.entries()));
  };

  const handlers: Record<
    string,
    (
      req: IncomingMessage,
      res: ServerResponse,
      p: Record<string, string>,
      q: URLSearchParams,
    ) => Promise<void>
  > = {
    "GET /api/config/benchmark": async (_req, res) => {
      ctx.json(res, 200, await svc.results());
    },
    "GET /api/config/benchmark/estimate": async (_req, res, _p, q) => {
      if (q.get("tier") === "overnight") {
        const count = Math.max(
          1,
          Math.min(
            MAX_OVERNIGHT_COMBINATIONS,
            Number(q.get("count") ?? q.getAll("combination").length) || 1,
          ),
        );
        const e = await svc.estimateOvernight(count, q.get("first") === "true");
        return ctx.json(res, 200, {
          fitsTonight: e.fitsTonight,
          hoursNeeded: e.hoursNeeded,
          nights: e.nights,
          line: e.line,
          window: { start: e.window.start, end: e.window.end, hours: e.window.hours },
        });
      }
      const c = await queryCombination(q);
      if (!c)
        return ctx.json(res, 400, {
          error:
            "Name the combination: ?combination=<combinationId>, or worker= and planner= (reviewer=, researcher= optional).",
        });
      const e = await svc.estimateQuick(c);
      ctx.json(res, 200, { ...e, copy: QUICK_TIER_COPY });
    },
    "GET /api/config/benchmark/runs/:runId": async (_req, res, p) => {
      const run = await svc.run(p.runId ?? "");
      if (!run) return ctx.json(res, 404, { error: `No benchmark run ${p.runId}.` });
      ctx.json(res, 200, { run });
    },
    "GET /api/config/benchmark/:combinationId": async (_req, res, p) => {
      ctx.json(res, 200, { results: await svc.history(p.combinationId ?? "") });
    },
    "POST /api/config/benchmark": async (req, res) => {
      const body = await ctx.readJsonBody(req);
      const list = Array.isArray(body.combinations) ? body.combinations.map(combinationOf) : [];
      if (list.some((c) => !c))
        return ctx.json(res, 400, {
          error: "Each combination names at least a Coding model and a Planning model.",
        });
      const combinations = list as Combination[];
      const principal = ctx.principalOf?.(req);
      if (body.tier === "quick") {
        if (combinations.length !== 1)
          return ctx.json(res, 400, {
            error: "A quick benchmark screens exactly one combination.",
          });
        const s = await svc.startQuick(combinations[0] as Combination, principal);
        return ctx.json(res, 200, { run: s.run, estimateSeconds: s.estimateSeconds });
      }
      if (body.tier === "overnight") {
        if (combinations.length < 1 || combinations.length > MAX_OVERNIGHT_COMBINATIONS)
          return ctx.json(res, 400, {
            error: `An overnight comparison takes 1 to ${MAX_OVERNIGHT_COMBINATIONS} combinations.`,
          });
        const q = await svc.scheduleOvernight(combinations, principal, {
          benchmarkFirst: body.first === true,
        });
        return ctx.json(res, 200, {
          run: q.run,
          estimateSeconds: Math.round(q.estimate.hoursNeeded * 3600),
          schedule: q.run.schedule,
          line: q.estimate.line,
        });
      }
      ctx.json(res, 400, { error: 'tier is "quick" or "overnight".' });
    },
    "POST /api/config/benchmark/runs/:runId/stop": async (req, res, p) => {
      ctx.json(res, 200, await svc.stop(p.runId ?? "", ctx.principalOf?.(req)));
    },
  };

  return {
    /** The routes this module serves, as `config_routes.ts` lists them. */
    routes: ROUTES.filter((r) => handlers[`${r.method} ${r.path}`]),
    /** Handle a request; true when it was a benchmark route. */
    async handle(
      req: IncomingMessage,
      res: ServerResponse,
      url: string,
      query?: URLSearchParams,
    ): Promise<boolean> {
      const found = match(req.method ?? "GET", url);
      if (!found) return false;
      if (found.route.method !== "GET" && !ctx.isTrustedMutation(req)) {
        ctx.json(res, 403, { error: "Actions must come from the dashboard itself" });
        return true;
      }
      if (found.route.permission !== "read" && !ctx.mayManage(req)) {
        ctx.json(res, 403, {
          error: "Only an Admin can start or stop a benchmark.",
          permission: found.route.permission,
          needs: "admin",
        });
        return true;
      }
      const q = query ?? new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
      const handler = handlers[`${found.route.method} ${found.route.path}`];
      try {
        await handler?.(req, res, found.params, q);
      } catch (err) {
        refused(res, err);
      }
      return true;
    },
  };
}
