import type { CardRecord, CardStore, EventLog } from "@sekhemet/kernel";
import { CRITERIA_APPROVAL_HOLD } from "@sekhemet/planner";
import {
  type ProjectFacts,
  type ProjectsOverview,
  type StatusSliceLike,
  type WaitingFacts,
  currentRelease,
} from "@sekhemet/ui";
import { type Audience, nameFor, soloAudience } from "./pm/audience.js";
import { projectStoryMap } from "./project_done.js";
import { statusFacts } from "./status_api.js";

/**
 * What the Projects page shows (dashboard §2.11, DB-N9-9, DB-N9-21; teams
 * item 5), served as `GET /api/projects/overview` (PM_CONTRACT §3): one
 * entry per project the person can see, never an archived one, and the
 * workspace's totals over those only (PM-N9-8). Each project's forecast,
 * lead and update come from Status's own reader (`statusFacts`), its release
 * from the story map through Status's `currentRelease`, so the two pages
 * never disagree. Health is recorded by B4.11 (teams NEW-teams-11): until
 * then it is null. No figure here is counted per person (DB-N9-7).
 */

const isIssue = (c: CardRecord) => c.tier !== "epic" && c.tier !== "initiative";
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export async function projectsOverview(deps: {
  cardStore: CardStore;
  log: EventLog;
  /** The person asking. */
  me: string;
  audience?: Audience;
  now?: Date;
  /** The server's repository, whose main branch proves requirements (the story map). */
  repoPath?: string;
  /** The models on this server and their load, read by the server. */
  models: ProjectsOverview["models"];
  /** Injectable for tests: the forecast's resampling. */
  random?: () => number;
}): Promise<ProjectsOverview> {
  const a = deps.audience ?? soloAudience();
  const team = a.setup === "team";
  const me = deps.me;
  const now = deps.now ?? new Date();
  const nowMs = now.getTime();
  const store = deps.cardStore;
  const visible = store.listProjects().filter((p) => p.status !== "archived" && a.canSee(me, p.id));
  const shown = new Set(visible.map((p) => p.id));
  const cards = (await store.listCards()).filter(
    (c) => isIssue(c) && c.projectId !== undefined && shown.has(c.projectId),
  );
  const byId = new Map(cards.map((c) => [c.id, c]));

  // When each issue entered the column it is in now (its wait), from the ledger.
  const moves = await deps.log.getEventsByTypes(["card/status_changed"]);
  const entered = new Map<string, string>();
  for (const e of moves) {
    const p = e.payload as { id?: string; toStatus?: string };
    const id = String(p.id ?? e.cardId ?? "");
    const card = byId.get(id);
    if (card && p.toStatus === card.status) entered.set(id, e.createdAt);
  }
  const since = (c: CardRecord) => entered.get(c.id) ?? c.updatedAt ?? c.createdAt;

  // The target is the release's (DB-N9-3, DEC-37); no release records one yet, and a
  // sprint's end is not a project's target, so every row says *No target set*.
  const target = null;
  const pending = store.runs.listDecisions("pending");
  const waiting: WaitingFacts[] = [];
  const projects: ProjectFacts[] = [];

  for (const project of visible) {
    const own = cards.filter((c) => c.projectId === project.id);
    const facts = await statusFacts({
      cardStore: store,
      log: deps.log,
      me,
      project: project.id,
      audience: a,
      now,
      ...(deps.random ? { random: deps.random } : {}),
    });
    const leadId = a.leadOf(project.id);
    // What waits on the person: theirs, or unowned where they lead (Status's rule).
    const mine = (c: CardRecord) => !team || c.owner === me || (!c.owner && facts.isLead);
    const here: WaitingFacts[] = [];
    const item = (c: CardRecord, kind: WaitingFacts["kind"], extra = {}): WaitingFacts => ({
      projectId: project.id,
      project: project.name,
      cardId: c.id,
      title: c.title,
      kind,
      since: since(c),
      ...extra,
    });
    for (const c of own.filter((x) => x.status === "review" && mine(x))) {
      here.push(item(c, "review"));
    }
    for (const d of pending) {
      const c = d.cardId ? byId.get(d.cardId) : undefined;
      if (c && c.projectId === project.id && mine(c)) {
        here.push({ ...item(c, "decision", { question: d.question }), since: d.createdAt });
      }
    }
    for (const c of own.filter((x) => x.status === "parked" && mine(x))) {
      here.push(item(c, "parked"));
    }
    // A plan waiting for the person's approval of its criteria, as Status's Needs you lists it.
    for (const c of own.filter(
      (x) => x.status === "planning" && (x.blockedReason ?? "").includes(CRITERIA_APPROVAL_HOLD),
    )) {
      if (mine(c)) here.push(item(c, "plan"));
    }
    waiting.push(...here);

    const map =
      deps.repoPath !== undefined
        ? await projectStoryMap(
            { repoPath: deps.repoPath, cardStore: store, log: deps.log },
            project.id,
          ).catch(() => undefined)
        : undefined;
    const release = map
      ? currentRelease((map as unknown as { slices: StatusSliceLike[] }).slices ?? [])
      : undefined;

    projects.push({
      id: project.id,
      name: project.name,
      state: await store.projectRollup(project.id),
      lead: leadId ? nameFor(a, leadId, me) : team ? null : "you",
      health: facts.health ?? null,
      updateMissing: facts.updateMissing,
      release: release ? { name: release.name, done: release.done, total: release.total } : null,
      forecast: facts.forecast,
      target,
      waitingOnYou: here.length,
      agent: {
        working: own.filter((c) => c.status === "in_progress").map((c) => c.title),
        queued: own.filter((c) => c.status === "ready").length,
      },
    });
  }

  // Shipped this month: issues moved to Done since the month began (UTC).
  const month = isoDay(nowMs).slice(0, 7);
  const shipped = new Set(
    moves
      .filter((e) => (e.payload as { toStatus?: string }).toStatus === "done")
      .filter((e) => e.createdAt.slice(0, 7) === month)
      .map((e) => String((e.payload as { id?: string }).id ?? e.cardId ?? ""))
      .filter((id) => byId.has(id)),
  );
  // The Agent's time today: its attempts that finished today, in projects the person sees.
  const today = isoDay(nowMs);
  const agentSecondsToday = store.runs
    .readAttemptOutcomes()
    .filter((o) => o.completedAt.slice(0, 10) === today && byId.has(o.cardId))
    .filter((o) => o.builtBy.kind === "worker")
    .reduce((n, o) => n + o.secondsUsed, 0);

  return {
    setup: team ? "team" : "solo",
    projects,
    waiting,
    shippedThisMonth: shipped.size,
    agentSecondsToday,
    models: deps.models,
  };
}
