import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute, join } from "node:path";
import type { BoardService } from "@sekhemet/board";
import {
  type CardStore,
  DEFAULT_DEPTH_PROFILE,
  type DepthProfile,
  type DepthProfileRecord,
  type EventLog,
  parseDepthProfile,
} from "@sekhemet/kernel";
import {
  type CapabilityModel,
  type Comparable,
  type ComparablesSearch,
  DESIGN_COPY,
  type DesignStageResult,
  type PlannerLedger,
  StaleApprovalError,
  approvePlan,
  capabilityModelOf,
  comparablesQuery,
  planApprovalView,
  planUpgrade,
  planUpgradeFixes,
  recordDepthChoice,
  surveyComparables,
  walkStoryMap,
} from "@sekhemet/planner";
import { mergeNetworkConfigs } from "@sekhemet/sandbox";
import { networkConfigs } from "./config_apply.js";
import { researchFetch } from "./research_consent.js";

/**
 * The person's side of planning (planner-pm §2.17, §2.16.4; PM-N7-3…5,
 * PM-N6-4, PM-N3): `sekhemet approve` shows a plan's criteria and example
 * tables and records a person's approval, which is what lets a card leave
 * Planning; `sekhemet upgrade` plans a dependency upgrade and, after its
 * gates ran, the child fix cards. And the inputs every plan takes from the
 * ledger: the Worker's measured record and the depth profile.
 */

interface Kernel {
  repoPath: string;
  cardStore: CardStore;
  log: EventLog;
  boardService?: Pick<BoardService, "transitionCard">;
}

function ledgerOf(k: Kernel): PlannerLedger {
  return {
    store: k.cardStore,
    log: k.log,
    ...(k.boardService ? { board: k.boardService } : {}),
  };
}

/**
 * The depth profile a project plans and approves under (DS-P14-3): the one
 * the person recorded for the project, else for the repository, read by the
 * kernel's one reader; `internal tool` only when none is recorded.
 */
export function projectDepthProfile(
  store: CardStore | undefined,
  projectId?: string,
): DepthProfile {
  return store ? store.depthProfiles.of(projectId).profile : DEFAULT_DEPTH_PROFILE;
}

/** What every plan reads from the ledger (PM-N3-2, PM-N7): the Worker's record and the profile. */
export async function planningInputs(
  k: Kernel,
  projectId?: string,
): Promise<{ capability: CapabilityModel; depthProfile: DepthProfile }> {
  return {
    capability: await capabilityModelOf(ledgerOf(k)),
    depthProfile: projectDepthProfile(k.cardStore, projectId),
  };
}

const O = DESIGN_COPY.offer;

/**
 * `sekhemet depth [<profile>] [--project <id>]` (DS-P14-1, -2, -4): with no
 * profile, the one in force and whether a person chose it; with one, the
 * local person's choice, recorded with a requirement for each must-have
 * quality-checklist row it adds.
 */
export async function depthCommand(
  k: Kernel,
  args: string[],
  print: (line: string) => void,
): Promise<number> {
  const at = args.indexOf("--project");
  const projectId = at === -1 ? undefined : args[at + 1];
  const name = args
    .filter((a, i) => !a.startsWith("--") && (at === -1 || i !== at + 1))
    .join(" ")
    .trim();
  if (!name) {
    const r = k.cardStore.depthProfiles.of(projectId);
    print(O.inForce(r.profile, r.recorded));
    return 0;
  }
  const profile = parseDepthProfile(name);
  if (!profile) {
    print(O.unknown(name));
    return 1;
  }
  const out = await recordDepthChoice(
    ledgerOf(k),
    { profile, ...(projectId !== undefined ? { projectId } : {}) },
    k.cardStore.localPrincipal(),
  );
  for (const line of out.lines) print(line);
  return 0;
}

/**
 * Offer the design stage's proposed profile (DS-P14-1): a recorded choice
 * stands and is not asked again; otherwise the proposal and its reason are
 * said, and — when there is a person to ask — their answer is recorded as
 * their choice (Enter accepts the proposal). With no one to ask, nothing is
 * recorded: cards plan as the default until a person chooses.
 */
export async function offerDepthProfile(
  k: Kernel,
  design: Pick<DesignStageResult, "depth">,
  options: {
    projectId?: string;
    print: (line: string) => void;
    ask?: (question: string) => Promise<string>;
  },
): Promise<DepthProfileRecord> {
  const current = k.cardStore.depthProfiles.of(options.projectId);
  const proposal = design.depth;
  if (current.recorded || !proposal) return current;
  options.print(O.proposed(proposal.profile, proposal.reason));
  if (!options.ask) {
    options.print(O.until(proposal.profile));
    return current;
  }
  const answer = (await options.ask(O.ask(proposal.profile))).trim();
  const profile = answer ? parseDepthProfile(answer) : proposal.profile;
  if (!profile) {
    options.print(O.unknown(answer));
    options.print(O.until(proposal.profile));
    return current;
  }
  const out = await recordDepthChoice(
    ledgerOf(k),
    {
      profile,
      proposal,
      ...(options.projectId !== undefined ? { projectId: options.projectId } : {}),
    },
    k.cardStore.localPrincipal(),
  );
  for (const line of out.lines) options.print(line);
  return out.record;
}

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * The comparables search, only when a person allowed research (DS-P14-5,
 * -9; §2.6): `--offline`, a project's `research = "no"`, or no recorded yes
 * gives no search and the reason instead — nothing is asked here (the one
 * question is `plan`'s, S8). A search sends only the short keyword query to
 * GitHub through the research fetch (the network policy, each request on the
 * ledger as `harness/egress`) and records it as `research/query`.
 */
export function comparablesSearchFor(
  repoPath: string,
  log: EventLog,
  options: { offline?: boolean; fetchImpl?: Fetch } = {},
): { search?: ComparablesSearch; notSearched?: string } {
  if (options.offline || process.env.SEKHEMET_OFFLINE === "1") {
    return { notSearched: "offline (--offline or SEKHEMET_OFFLINE)" };
  }
  const n = networkConfigs(repoPath);
  if (n.project.research === "no") {
    return { notSearched: 'research is off for this project (research = "no")' };
  }
  if (mergeNetworkConfigs(n.user, n.project).research !== "yes") {
    return { notSearched: 'research is off ([network] research is not "yes")' };
  }
  const f: Fetch = options.fetchImpl ?? researchFetch(repoPath, log);
  const search: ComparablesSearch = async (query) => {
    let found: Comparable[] = [];
    let ok = false;
    try {
      const res = await f(
        `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=10`,
        {
          headers: { "User-Agent": "sekhemet", Accept: "application/vnd.github+json" },
          signal: AbortSignal.timeout(8000),
        },
      );
      if (!res.ok) throw new Error(`${res.status} from api.github.com`);
      const body = (await res.json()) as {
        items?: { full_name: string; html_url: string; topics?: string[] }[];
      };
      found = (body.items ?? []).map((r) => ({
        name: r.full_name.split("/").pop() ?? r.full_name,
        url: r.html_url,
        features: r.topics ?? [],
      }));
      ok = true;
      return found;
    } finally {
      // DS-S8-3: the keywords and the names found are free text: the private part.
      await log
        .append({
          actor: "harness",
          type: "research/query",
          payload: { source: "comparables", ok, count: found.length },
          private: { query, results: found.map((c) => c.name) },
        })
        .catch(() => undefined);
    }
  };
  return { search };
}

/**
 * What `plan` adds after the cards exist (design-stage §2.8, P14): for a new
 * project or a brief, the comparables — searched only when research is
 * allowed, and said to be unsearched otherwise (DS-P14-5, -9) — and, once the
 * project has a story map, one walk per named user role (DS-P14-7). Every
 * feature and stuck step is a candidate a person accepts or rejects; none is
 * a requirement until then (DS-P14-6).
 */
export async function designCoverage(
  k: Kernel,
  design: DesignStageResult,
  options: {
    projectId?: string;
    offline?: boolean;
    fetchImpl?: Fetch;
    print: (line: string) => void;
  },
): Promise<{ candidateIds: string[] }> {
  const ledger = ledgerOf(k);
  const candidateIds: string[] = [];
  if (design.depth && comparablesQuery(design.buildSpec)) {
    const { search, notSearched } = comparablesSearchFor(k.repoPath, k.log, {
      ...(options.offline ? { offline: true } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    const out = await surveyComparables(ledger, {
      buildSpec: design.buildSpec,
      ...(options.projectId !== undefined ? { projectId: options.projectId } : {}),
      ...(search ? { search } : {}),
      ...(notSearched ? { notSearched } : {}),
    });
    for (const line of out.lines) options.print(line);
    candidateIds.push(...out.candidateIds);
  }
  if (options.projectId !== undefined) {
    const walked = await walkStoryMap(ledger, { projectId: options.projectId, design });
    for (const line of walked.lines) options.print(line);
    candidateIds.push(...walked.walks.flatMap((w) => w.candidateIds));
  }
  return { candidateIds };
}

/**
 * `sekhemet approve <card|epic> [--show]`: print what is to be approved — the
 * criteria and the example tables (given → expected), and the staged files
 * the profile asks for — then, unless `--show`, record the local person's
 * approval and move every card with no other hold out of Planning. What it
 * prints is `planApprovalView`, the same the dashboard shows.
 */
export async function approveCommand(
  k: Kernel,
  args: string[],
  print: (line: string) => void,
): Promise<number> {
  const id = args.find((a) => !a.startsWith("--"));
  if (!id) {
    print("Usage: sekhemet approve <card|epic> [--show]");
    return 1;
  }
  const ledger = ledgerOf(k);
  const card = await k.cardStore.getCard(id);
  if (!card) {
    print(`No issue ${id}.`);
    return 1;
  }
  const profile = projectDepthProfile(k.cardStore, card.projectId);
  const view = await planApprovalView(ledger, id, profile);
  for (const c of view.cards) {
    print(`${c.id} [${c.status}] ${c.title}`);
    for (const cr of c.criteria) print(`  ${cr.id}: ${cr.text}`);
    for (const e of c.examples) print(`    ${e}`);
    for (const t of c.tests) {
      print(
        `  ${t.what === "file" ? "Test file" : "Example tables"}: ${t.path}${t.approved ? " (approved)" : ""}`,
      );
    }
  }
  if (args.includes("--show")) return 0;
  const principal = k.cardStore.localPrincipal();
  const out = await approvePlan(ledger, id, principal, { profile, expectedSha256: view.sha256 });
  print(
    `Approved ${out.approved.length} issue(s) under the ${profile} profile; ${out.released.length} left Planning.`,
  );
  for (const h of out.held) print(`  ${h.id} stays in Planning: ${h.reason}`);
  return 0;
}

export interface PlanApprovalRouteContext {
  repoPath: string;
  cardStore?: CardStore | undefined;
  log: EventLog;
  boardService: Pick<BoardService, "transitionCard">;
  json: (res: ServerResponse, status: number, body: unknown) => void;
  readJsonBody: (req: IncomingMessage) => Promise<Record<string, unknown>>;
  /** The dashboard's write check (the action header, and a Team session's own origin). */
  trusted: (req: IncomingMessage) => boolean;
  /** The person a request is for (teams §2.3, kernel rule 19). */
  principalOf: (req: IncomingMessage) => string;
  /** Whether the request's person can see a project (PM-N9-8); omitted, every project. */
  canSee?: ((req: IncomingMessage, projectId: string | undefined) => boolean) | undefined;
}

const APPROVAL_ROUTE = /^\/api\/cards\/([A-Za-z0-9_.-]+)\/(approval|approve)$/;

/**
 * The dashboard's side of `sekhemet approve` (PM-N7-5, PM_CONTRACT §approval):
 *
 *   GET  /api/cards/:id/approval   what a person approves for a card or an
 *                                  epic: each card's criteria, example rows
 *                                  and the staged files its profile asks for,
 *                                  with one SHA-256 of all of it
 *   POST /api/cards/:id/approve    `{ sha256 }`: the person's approval of what
 *                                  they were shown; 409 with what is there now
 *                                  when it has changed since
 *
 * The POST is a Member's `issue.edit` (team/access.ts), needs the
 * dashboard's write check and is recorded with the person's principal.
 */
export async function handlePlanApprovalRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  ctx: PlanApprovalRouteContext,
): Promise<boolean> {
  const m = APPROVAL_ROUTE.exec(url);
  if (!m) return false;
  const [, id, verb] = m as unknown as [string, string, "approval" | "approve"];
  if ((verb === "approval") !== (req.method === "GET")) return false;
  if (verb === "approve" && req.method !== "POST") return false;
  const { json } = ctx;
  if (verb === "approve" && !ctx.trusted(req)) {
    json(res, 403, { error: "An approval must come from the dashboard itself" });
    return true;
  }
  const store = ctx.cardStore;
  if (!store) {
    json(res, 501, { error: "This server was started read-only" });
    return true;
  }
  const card = await store.getCard(id);
  // PM-N9-8: a card the person cannot see answers exactly as a missing one.
  if (!card || !(ctx.canSee?.(req, card.projectId) ?? true)) {
    json(res, 404, { error: `No issue ${id}` });
    return true;
  }
  const ledger: PlannerLedger = { store, log: ctx.log, board: ctx.boardService };
  const profile = projectDepthProfile(store, card.projectId);
  if (verb === "approval") {
    json(res, 200, await planApprovalView(ledger, id, profile));
    return true;
  }
  let body: Record<string, unknown>;
  try {
    body = await ctx.readJsonBody(req);
  } catch (err) {
    json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    return true;
  }
  const sha256 = typeof body.sha256 === "string" ? body.sha256 : "";
  if (!sha256) {
    json(res, 400, {
      error: "An approval names the sha256 of what was shown (GET /api/cards/:id/approval)",
    });
    return true;
  }
  try {
    const out = await approvePlan(ledger, id, ctx.principalOf(req), {
      profile,
      expectedSha256: sha256,
    });
    json(res, 200, { ok: true, profile, ...out });
  } catch (err) {
    if (err instanceof StaleApprovalError) {
      json(res, 409, { error: err.message, reason: "stale", current: err.current });
      return true;
    }
    json(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
  return true;
}

/**
 * `sekhemet upgrade <package> <from> <to> [--changelog <file>]` plans the
 * upgrade card (a tool step, PM-N6-4); `sekhemet upgrade fixes <card>` turns
 * each file its gates failed in into a child fix card citing the changelog.
 */
export async function upgradeCommand(
  k: Kernel,
  args: string[],
  print: (line: string) => void,
): Promise<number> {
  const ledger = ledgerOf(k);
  if (args[0] === "fixes") {
    const cardId = args[1];
    if (!cardId) {
      print("Usage: sekhemet upgrade fixes <upgrade-card>");
      return 1;
    }
    const { created } = await planUpgradeFixes(ledger, cardId);
    print(
      created.length === 0
        ? `No new failing file under ${cardId}: no fix issue planned.`
        : `Planned ${created.length} fix issue(s): ${created.join(", ")}. Approve them with: sekhemet approve ${cardId}`,
    );
    return 0;
  }
  const [pkg, from, to] = args.filter(
    (a, i, all) => !a.startsWith("--") && all[i - 1] !== "--changelog",
  );
  if (!pkg || !from || !to) {
    print(
      "Usage: sekhemet upgrade <package> <from> <to> [--changelog <file>] | sekhemet upgrade fixes <card>",
    );
    return 1;
  }
  const i = args.indexOf("--changelog");
  const file = i === -1 ? undefined : args[i + 1];
  const path = file ? (isAbsolute(file) ? file : join(k.repoPath, file)) : undefined;
  const changelog = path && existsSync(path) ? readFileSync(path, "utf8") : undefined;
  const { cardId, command, entries } = await planUpgrade(ledger, {
    root: k.repoPath,
    pkg,
    from,
    to,
    ...(changelog ? { changelog } : {}),
  });
  print(`Planned ${cardId}: the tool step is \`${command.join(" ")}\`, then the checks.`);
  print(
    entries.length > 0
      ? `Changelog entries between ${from} and ${to}: ${entries.map((e) => e.version).join(", ")}.`
      : "No changelog entries were given for the versions between.",
  );
  print(`It waits in Planning for your approval: sekhemet approve ${cardId}`);
  return 0;
}
