import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute, join } from "node:path";
import type { BoardService } from "@sekhemet/board";
import type { CardStore, EventLog } from "@sekhemet/kernel";
import {
  type CapabilityModel,
  DEFAULT_DEPTH_PROFILE,
  type DepthProfile,
  type PlannerLedger,
  StaleApprovalError,
  approvePlan,
  capabilityModelOf,
  planApprovalView,
  planUpgrade,
  planUpgradeFixes,
} from "@sekhemet/planner";

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
 * The depth profile a project plans and approves under. Design-stage P14
 * builds the profile and no configuration key sets it yet, so every project
 * is `internal tool` (the profile `checkMain` judges strength by too).
 */
export function projectDepthProfile(_repoPath: string): DepthProfile {
  return DEFAULT_DEPTH_PROFILE;
}

/** What every plan reads from the ledger (PM-N3-2, PM-N7): the Worker's record and the profile. */
export async function planningInputs(
  k: Kernel,
): Promise<{ capability: CapabilityModel; depthProfile: DepthProfile }> {
  return {
    capability: await capabilityModelOf(ledgerOf(k)),
    depthProfile: projectDepthProfile(k.repoPath),
  };
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
  if (!(await k.cardStore.getCard(id))) {
    print(`No card ${id}.`);
    return 1;
  }
  const profile = projectDepthProfile(k.repoPath);
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
    `Approved ${out.approved.length} card(s) under the ${profile} profile; ${out.released.length} left Planning.`,
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
    json(res, 404, { error: `No card ${id}` });
    return true;
  }
  const ledger: PlannerLedger = { store, log: ctx.log, board: ctx.boardService };
  const profile = projectDepthProfile(ctx.repoPath);
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
        ? `No new failing file under ${cardId}: no fix card planned.`
        : `Planned ${created.length} fix card(s): ${created.join(", ")}. Approve them with: sekhemet approve ${cardId}`,
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
  print(`Planned ${cardId}: the tool step is \`${command.join(" ")}\`, then the gates.`);
  print(
    entries.length > 0
      ? `Changelog entries between ${from} and ${to}: ${entries.map((e) => e.version).join(", ")}.`
      : "No changelog entries were given for the versions between.",
  );
  print(`It waits in Planning for your approval: sekhemet approve ${cardId}`);
  return 0;
}
