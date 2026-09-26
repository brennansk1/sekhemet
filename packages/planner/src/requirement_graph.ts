import type {
  CardRecord,
  CardStatus,
  ChangelogCategory,
  KanoClass,
  ReleaseProposal,
  Requirement,
  RequirementCriterion,
  RequirementRevision,
  Slice,
  SliceAppetite,
  TraceLink,
} from "@sekhemet/kernel";
import { type PlannerLedger, moveCard } from "./ledger.js";
import { contentWords } from "./text.js";
import { overlap } from "./traces.js";

/**
 * When a project is done — computed, never claimed (planner-pm §2.15, P13).
 *
 * The kernel keeps the records (requirements, links, slices, `slice/accepted`,
 * `release/proposed`); this module reads them and decides: which requirements
 * are proven, which slices are proven and done, whether the project is done,
 * when a slice's appetite stops its cards, what a revision holds, and what a
 * model's claim of "complete" or "ready" is worth (nothing). Everything is
 * computed from the ledger, so a replay gives the same answer.
 *
 * Proven (§2.15.5): the requirement's acceptance tests pass on the
 * integration branch, their test-strength record meets the depth profile's
 * rule, and no link to it is suspect. The result on `main` is the latest
 * `requirement/main_checked` record, which the harness writes after running
 * the project gates and the linked tests in a scratch checkout of `main`.
 * Until the depth profile exists (design-stage P14) the rule is the
 * *internal tool* profile's.
 */

/** Written by the harness after running the gates and the linked tests on `main`. */
export const MAIN_CHECKED = "requirement/main_checked";
/** A person accepted the brief: its slices and requirements were stored (PM-P13-1). */
export const BRIEF_ACCEPTED = "brief/accepted";
/** The profile whose test-strength rule counts until design-stage P14 builds the depth profile. */
export const PROVEN_PROFILE = "internal tool";

export type RequirementState =
  | "cut"
  | "suspect"
  | "unplanned"
  | "planned"
  | "failing"
  | "passing_strength_unmet"
  | "proven";

/** One linked test's result on `main`, with its strength against the profile's rule. */
export interface MainTestResult {
  result: "passed" | "failed" | "missing";
  strength: "met" | "unmet" | "unmeasured";
}

export interface MainCheck {
  /** The integration branch's head the check ran on. */
  sha: string;
  branch: string;
  /** Every blocking project gate passed on that head. */
  gatesPassed: boolean;
  /** Keyed by test link ref: a file, or `file > test name`. */
  tests: Record<string, MainTestResult>;
  /** The depth profile whose rule `strength` was judged against. */
  profile: string;
  seq: number;
  at: string;
}

// --- Accepting the brief (PM-P13-1) --------------------------------------------

export interface BriefRequirementInput {
  /** A name other requirements of this brief depend on it by; its id otherwise. */
  key?: string;
  id?: string;
  title: string;
  kano?: KanoClass;
  /** `true` when omitted; a nice-to-have is `~` in the brief. */
  mustHave?: boolean;
  criteria?: RequirementCriterion[];
  /** Keys of this brief's requirements, or ids of requirements already accepted. */
  dependsOn?: string[];
}

export interface BriefSliceInput {
  id?: string;
  title: string;
  /** Set before planning (§2.15.7). */
  appetite: SliceAppetite;
  requirements: BriefRequirementInput[];
}

export interface BriefInput {
  projectId: string;
  /** What the person has before the project: the release report compares with it (§2.15.9). */
  baseline: string;
  slices: BriefSliceInput[];
}

/**
 * A person accepts the brief (PM-P13-1): each slice with its appetite, then
 * each requirement with its id, version 1, dependencies, Kano class, must-have
 * mark, criteria and slice, as the kernel's events; last `brief/accepted`
 * naming them, the baseline private. Everything is checked before the first
 * event, so a refused brief writes nothing.
 */
export async function acceptBrief(
  ledger: PlannerLedger,
  brief: BriefInput,
  principal: string,
): Promise<{ sliceIds: string[]; requirementIds: string[] }> {
  if (!principal) throw new Error("A brief is accepted by a person; no principal was given");
  if (!ledger.store.getProject(brief.projectId)) {
    throw new Error(`No project ${brief.projectId}`);
  }
  if (brief.slices.length === 0) throw new Error("A brief has at least one slice");
  const existing = new Set((await ledger.store.requirements.list()).map((r) => r.id));
  const all = brief.slices.flatMap((s, si) => s.requirements.map((r) => ({ r, si })));
  for (const [i, s] of brief.slices.entries()) {
    if (!s.title.trim()) throw new Error(`Slice ${i + 1} has no title`);
    if (s.requirements.length === 0) throw new Error(`Slice "${s.title}" has no requirement`);
    if (s.appetite.cards === undefined && s.appetite.hours === undefined) {
      throw new Error(`Slice "${s.title}": an appetite is a card budget, a time budget or both`);
    }
  }
  const keyOf = (r: BriefRequirementInput, i: number) => r.key ?? r.id ?? `#${i}`;
  const keys = new Map<string, number>();
  for (const [i, { r }] of all.entries()) {
    if (!r.title.trim()) throw new Error(`Requirement ${i + 1} has no title`);
    const key = keyOf(r, i);
    if (keys.has(key)) throw new Error(`Two requirements of the brief are named ${key}`);
    if (r.id !== undefined && existing.has(r.id)) {
      throw new Error(`Requirement id ${r.id} was used before; a requirement id is never reused`);
    }
    keys.set(key, i);
  }
  for (const [i, { r }] of all.entries()) {
    for (const d of r.dependsOn ?? []) {
      if (!keys.has(d) && !existing.has(d)) {
        throw new Error(
          `${keyOf(r, i)} depends on ${d}, which is neither in the brief nor accepted`,
        );
      }
    }
  }
  // Dependencies first; a cycle within the brief is refused.
  const order: number[] = [];
  const state = new Map<number, "visiting" | "done">();
  const visit = (i: number, path: string[]) => {
    if (state.get(i) === "done") return;
    const key = keyOf((all[i] as { r: BriefRequirementInput }).r, i);
    if (state.get(i) === "visiting") {
      throw new Error(`The brief's dependencies close a cycle: ${[...path, key].join(" -> ")}`);
    }
    state.set(i, "visiting");
    for (const d of (all[i] as { r: BriefRequirementInput }).r.dependsOn ?? []) {
      const j = keys.get(d);
      if (j !== undefined) visit(j, [...path, key]);
    }
    state.set(i, "done");
    order.push(i);
  };
  for (let i = 0; i < all.length; i++) visit(i, []);

  const sliceIds: string[] = [];
  for (const s of brief.slices) {
    sliceIds.push(
      await ledger.store.slices.create(
        {
          ...(s.id !== undefined ? { id: s.id } : {}),
          projectId: brief.projectId,
          title: s.title,
          appetite: s.appetite,
        },
        principal,
      ),
    );
  }
  const idOf = new Map<string, string>();
  const created: { i: number; id: string }[] = [];
  for (const i of order) {
    const { r, si } = all[i] as { r: BriefRequirementInput; si: number };
    const made = await ledger.store.requirements.create(
      {
        ...(r.id !== undefined ? { id: r.id } : {}),
        title: r.title,
        sliceId: sliceIds[si] as string,
        ...(r.kano !== undefined ? { kano: r.kano } : {}),
        mustHave: r.mustHave ?? true,
        criteria: r.criteria ?? [],
        dependsOn: (r.dependsOn ?? []).map((d) => idOf.get(d) ?? d),
      },
      principal,
    );
    idOf.set(keyOf(r, i), made.id);
    created.push({ i, id: made.id });
  }
  const requirementIds = created.sort((a, b) => a.i - b.i).map((c) => c.id);
  await ledger.log.append({
    actor: "human",
    type: BRIEF_ACCEPTED,
    payload: { projectId: brief.projectId, sliceIds, requirementIds },
    principal,
    private: { baseline: brief.baseline },
  });
  return { sliceIds, requirementIds };
}

/** The baseline the latest accepted brief of the project states, or undefined. */
export async function briefBaseline(
  ledger: PlannerLedger,
  projectId: string,
): Promise<string | undefined> {
  const events = (await ledger.log.getEventsByTypes([BRIEF_ACCEPTED])).filter(
    (e) => (e.payload as { projectId?: string }).projectId === projectId,
  );
  const baseline = events.at(-1)?.private?.baseline;
  return typeof baseline === "string" ? baseline : undefined;
}

/** The project of the latest accepted brief, else the first project with a slice. */
export async function defaultRequirementProject(
  ledger: PlannerLedger,
): Promise<string | undefined> {
  const brief = (await ledger.log.getEventsByTypes([BRIEF_ACCEPTED])).at(-1);
  if (brief) return String((brief.payload as { projectId: string }).projectId);
  return (await ledger.store.slices.list())[0]?.projectId;
}

// --- The result on main ----------------------------------------------------------

/** Record what the gates and the linked tests did on the integration branch's head. */
export async function recordMainCheck(
  ledger: PlannerLedger,
  check: Omit<MainCheck, "seq" | "at">,
  failures: readonly string[] = [],
): Promise<void> {
  await ledger.log.append({
    actor: "gate",
    type: MAIN_CHECKED,
    payload: {
      sha: check.sha,
      branch: check.branch,
      gatesPassed: check.gatesPassed,
      tests: check.tests,
      profile: check.profile,
    },
    ...(failures.length > 0 ? { private: { failures: [...failures] } } : {}),
  });
}

export async function latestMainCheck(ledger: PlannerLedger): Promise<MainCheck | undefined> {
  const last = (await ledger.log.getEventsByTypes([MAIN_CHECKED])).at(-1);
  if (!last) return undefined;
  const p = last.payload as Omit<MainCheck, "seq" | "at">;
  return { ...p, seq: last.seq, at: last.createdAt };
}

/** How much two phrases must share to count as the same criterion (traces.ts's own threshold). */
const CRITERION_MATCH = 0.5;

/**
 * Link the card's staged test cases to the requirements it traces to
 * (§2.15.2: red-first staging writes test → criterion): a case proving a
 * criterion of one of those requirements links `file > case` to it; a staged
 * file none of whose cases names such a criterion links as a whole to every
 * requirement the card traces to. A link that exists is not written again.
 *
 * A case's own `criterionId` is the planner's card-scoped id
 * (`<card>.c<n>`), which never equals a brief's requirement-criterion id
 * (`REQ-1.1`): comparing them directly (as this used to) always fails,
 * silently falling back to linking every staged file to every requirement
 * the card traces to. The match is instead by the criterion's own words —
 * the card's stored `acceptanceCriteria` text at that criterion id — against
 * each traced requirement's criteria (the same word-overlap the "named"
 * capability-fallback trace uses, `traces.ts`), scoped to only the
 * requirements this card already traces to (PM-P13-2's resolution, so a
 * model's stated `requirementIds` bounds what a case can match).
 */
export async function linkStagedTests(ledger: PlannerLedger, cardId: string): Promise<number> {
  const reqIds = [
    ...new Set(ledger.store.requirements.linksFrom("card", cardId).map((l) => l.requirementId)),
  ];
  if (reqIds.length === 0) return 0;
  const reqs = (await Promise.all(reqIds.map((id) => ledger.store.requirements.get(id)))).filter(
    (r): r is Requirement => r !== undefined,
  );
  const card = await ledger.store.getCard(cardId);
  // The card's own criterion text, by the card-scoped id its staged cases carry.
  const criterionText = new Map<string, string>();
  (card?.criterionIds ?? []).forEach((cid, i) => {
    const text = card?.acceptanceCriteria?.[i];
    if (text) criterionText.set(cid, text);
  });
  const bestMatch = (criterionId: string): Requirement | undefined => {
    const text = criterionText.get(criterionId);
    if (!text) return undefined;
    const words = contentWords(text);
    if (words.length === 0) return undefined;
    let best: { r: Requirement; score: number } | undefined;
    for (const r of reqs) {
      for (const k of r.criteria) {
        const score = overlap(words, contentWords(k.text));
        if (score >= CRITERION_MATCH && (!best || score > best.score)) best = { r, score };
      }
    }
    return best?.r;
  };
  const staged = ledger.store.stagedTests.staged(cardId);
  const files = staged.length
    ? staged.map((s) => ({ path: s.path, cases: s.cases ?? [] }))
    : (card?.acceptanceTests ?? []).map((path) => ({
        path,
        cases: [],
      }));
  let written = 0;
  const link = async (requirementId: string, ref: string) => {
    if (
      ledger.store.requirements.links(requirementId).some((l) => l.from === "test" && l.ref === ref)
    ) {
      return;
    }
    await ledger.store.requirements.link({ requirementId, from: "test", ref });
    written += 1;
  };
  for (const f of files) {
    let matched = false;
    for (const c of f.cases) {
      const r = bestMatch(c.criterionId);
      if (r) {
        matched = true;
        await link(r.id, `${f.path} > ${c.name}`);
      }
    }
    if (!matched) for (const r of reqs) await link(r.id, f.path);
  }
  return written;
}

// --- The story map: proven, unplanned, done (PM-P13-3, -4, -5, -7, -8) -------------

export interface RequirementView {
  id: string;
  version: number;
  title?: string;
  sliceId?: string;
  kano?: KanoClass;
  mustHave: boolean;
  dependsOn: string[];
  state: RequirementState;
  /** Why it is in that state, in a sentence. */
  why: string;
  cards: { id: string; status?: CardStatus; suspect: boolean }[];
  tests: {
    ref: string;
    suspect: boolean;
    result?: MainTestResult["result"];
    strength?: MainTestResult["strength"];
  }[];
}

export interface SliceView {
  id: string;
  projectId: string;
  title?: string;
  appetite: SliceAppetite;
  appetiteReached: boolean;
  extensions: number;
  accepted: boolean;
  /** `done` = proven and accepted by a person; an accepted slice a revision unproved is `unproven`. */
  state: "unproven" | "proven" | "done";
  mustHaves: { proven: number; total: number };
  provenLine: string;
  /** Must-haves with no card (PM-P13-3). */
  unplanned: string[];
  requirements: RequirementView[];
  /** What keeps it from proven, one line each; empty when proven. */
  blockers: string[];
}

export interface StoryMap {
  projectId: string;
  baseline?: string;
  main?: { sha: string; branch: string; gatesPassed: boolean; at: string; stale: boolean };
  slices: SliceView[];
  unplanned: { id: string; title?: string; sliceId?: string }[];
  mustHaves: { proven: number; total: number };
  provenLine: string;
  /** Only through a person's acceptance of the last slice (PM-P13-8). */
  projectDone: boolean;
}

export function provenLine(n: { proven: number; total: number }): string {
  return `${n.proven} of ${n.total} must-have${n.total === 1 ? "" : "s"} proven`;
}

function requirementView(
  r: Requirement,
  links: TraceLink[],
  cards: Map<string, CardRecord>,
  main: MainCheck | undefined,
  stale: boolean,
): RequirementView {
  const cardLinks = links.filter(
    (l) => l.from === "card" && cards.get(l.ref)?.status !== "rejected",
  );
  const testLinks = links.filter((l) => l.from === "test");
  const tests = testLinks.map((l) => {
    const res = main && !stale ? main.tests[l.ref] : undefined;
    return {
      ref: l.ref,
      suspect: l.suspect,
      ...(res ? { result: res.result, strength: res.strength } : {}),
    };
  });
  const base = {
    id: r.id,
    version: r.version,
    ...(r.title !== undefined ? { title: r.title } : {}),
    ...(r.sliceId !== undefined ? { sliceId: r.sliceId } : {}),
    ...(r.kano !== undefined ? { kano: r.kano } : {}),
    mustHave: r.mustHave,
    dependsOn: r.dependsOn,
    cards: cardLinks.map((l) => ({
      id: l.ref,
      ...(cards.get(l.ref) ? { status: (cards.get(l.ref) as CardRecord).status } : {}),
      suspect: l.suspect,
    })),
    tests,
  };
  const at = (state: RequirementState, why: string): RequirementView => ({ ...base, state, why });
  if (r.cut) return at("cut", "A person cut it from its slice.");
  const suspect = links.filter((l) => l.suspect);
  if (suspect.length > 0) {
    return at(
      "suspect",
      `Revised to version ${r.version}; ${suspect.map((l) => `${l.from} ${l.ref} (v${l.version})`).join(", ")} ${suspect.length === 1 ? "is" : "are"} not re-confirmed.`,
    );
  }
  if (cardLinks.length === 0) return at("unplanned", "No card traces to it.");
  if (testLinks.length === 0) return at("planned", "No acceptance test traces to it yet.");
  if (!main) return at("planned", "Its tests have not run on main yet.");
  if (stale) return at("planned", "Main moved since its tests last ran there.");
  const unrun = tests.filter((t) => t.result === undefined);
  if (unrun.length > 0) {
    return at("planned", `${unrun.map((t) => t.ref).join(", ")} has not run on main yet.`);
  }
  const failing = tests.filter((t) => t.result !== "passed");
  if (failing.length > 0) {
    return at(
      "failing",
      `On main: ${failing.map((t) => `${t.ref} ${t.result === "missing" ? "reported no result" : "failed"}`).join("; ")}.`,
    );
  }
  const weak = tests.filter((t) => t.strength !== "met");
  if (weak.length > 0) {
    return at(
      "passing_strength_unmet",
      `Passing on main, strength unmet for the ${main.profile} profile: ${weak.map((t) => `${t.ref} (${t.strength})`).join(", ")}.`,
    );
  }
  return at("proven", "Its tests pass on main and meet the profile's strength rule.");
}

/**
 * The story map as the ledger leaves it (PM-P13-3, -4, -5, -7, -8): each
 * slice's requirements with their state, the must-haves proven, the
 * unplanned ones, and whether the project is done. `mainSha` is the
 * integration branch's head now: a check on another head proves nothing.
 */
export async function storyMap(
  ledger: PlannerLedger,
  options: { projectId: string; mainSha?: string | undefined },
): Promise<StoryMap> {
  const { projectId } = options;
  const main = await latestMainCheck(ledger);
  // Undefined means not proven (fail closed): not knowing the integration
  // branch's head now is not the same as knowing it has not moved.
  const stale =
    main !== undefined && (options.mainSha === undefined || main.sha !== options.mainSha);
  const cards = new Map((await ledger.store.listCards()).map((c) => [c.id, c] as const));
  const slices = await ledger.store.slices.list(projectId);
  const reqs = await ledger.store.requirements.list({ projectId });
  const views = new Map(
    reqs.map(
      (r) =>
        [
          r.id,
          requirementView(r, ledger.store.requirements.links(r.id), cards, main, stale),
        ] as const,
    ),
  );
  const sliceViews: SliceView[] = slices.map((s) => sliceView(s, views, main, stale));
  const unplanned = [...views.values()]
    .filter((v) => v.mustHave && v.state === "unplanned")
    .map((v) => ({
      id: v.id,
      ...(v.title !== undefined ? { title: v.title } : {}),
      ...(v.sliceId !== undefined ? { sliceId: v.sliceId } : {}),
    }));
  const counted = [...views.values()].filter((v) => v.mustHave && v.state !== "cut");
  const mustHaves = {
    proven: counted.filter((v) => v.state === "proven").length,
    total: counted.length,
  };
  const rollup = ledger.store.getProject(projectId)
    ? await ledger.store.projectRollup(projectId)
    : undefined;
  const baseline = await briefBaseline(ledger, projectId);
  return {
    projectId,
    ...(baseline !== undefined ? { baseline } : {}),
    ...(main
      ? {
          main: {
            sha: main.sha,
            branch: main.branch,
            gatesPassed: main.gatesPassed,
            at: main.at,
            stale,
          },
        }
      : {}),
    slices: sliceViews,
    unplanned,
    mustHaves,
    provenLine: provenLine(mustHaves),
    projectDone:
      rollup === "done" && sliceViews.length > 0 && sliceViews.every((s) => s.state === "done"),
  };
}

function sliceView(
  s: Slice,
  views: Map<string, RequirementView>,
  main: MainCheck | undefined,
  stale: boolean,
): SliceView {
  const reqs = s.requirementIds
    .map((id) => views.get(id))
    .filter((v): v is RequirementView => v !== undefined);
  const must = reqs.filter((v) => v.mustHave && v.state !== "cut");
  const mustHaves = { proven: must.filter((v) => v.state === "proven").length, total: must.length };
  const unplanned = must.filter((v) => v.state === "unplanned").map((v) => v.id);
  const blockers: string[] = [];
  // A slice with no must-have requirements at all has nothing proven: it is
  // not "vacuously" done just because there is nothing left to fail.
  if (must.length === 0) blockers.push("It has no must-have requirements traced to it.");
  for (const v of must.filter((x) => x.state !== "proven")) {
    blockers.push(`${v.id} is ${v.state.replace(/_/g, " ")}: ${v.why}`);
  }
  if (!main) blockers.push("The project gates have not run on main yet.");
  else if (stale) blockers.push("Main moved since the project gates last ran there.");
  else if (!main.gatesPassed) blockers.push("The project gates fail on main.");
  const proven = blockers.length === 0;
  return {
    id: s.id,
    projectId: s.projectId,
    ...(s.title !== undefined ? { title: s.title } : {}),
    appetite: s.appetite,
    appetiteReached: s.appetiteReached,
    extensions: s.extensions,
    accepted: s.accepted,
    state: proven ? (s.accepted ? "done" : "proven") : "unproven",
    mustHaves,
    provenLine: provenLine(mustHaves),
    unplanned,
    requirements: reqs,
    blockers,
  };
}

/** The slice's view in its project's story map, or undefined. */
export async function sliceStatus(
  ledger: PlannerLedger,
  sliceId: string,
  mainSha?: string,
): Promise<{ map: StoryMap; slice: SliceView } | undefined> {
  const s = await ledger.store.slices.get(sliceId);
  if (!s) return undefined;
  const map = await storyMap(ledger, { projectId: s.projectId, mainSha });
  const slice = map.slices.find((x) => x.id === sliceId);
  return slice ? { map, slice } : undefined;
}

// --- A person accepts a slice (PM-P13-7, -8) ----------------------------------------

/**
 * A person accepts a proven slice: `slice/accepted` with their principal,
 * completing the project when every other slice of it is already done
 * (PM-P13-8). An unproven slice is refused, naming what is unproven.
 */
export async function acceptSlice(
  ledger: PlannerLedger,
  sliceId: string,
  principal: string,
  mainSha?: string,
): Promise<{ completesProject: boolean; slice: SliceView }> {
  if (!principal) throw new Error("A slice is accepted by a person; no principal was given");
  const status = await sliceStatus(ledger, sliceId, mainSha);
  if (!status) throw new Error(`No slice ${sliceId}`);
  const { map, slice } = status;
  if (slice.state === "done") throw new Error(`Slice ${sliceId} is already accepted`);
  if (slice.state !== "proven") {
    throw new Error(
      `Slice ${sliceId} is not proven (${slice.provenLine}), so it cannot be accepted: ${slice.blockers.join(" ")}`,
    );
  }
  const completesProject = map.slices.every((s) => s.id === sliceId || s.state === "done");
  await ledger.store.recordSliceAccepted(
    { projectId: slice.projectId, sliceId, completesProject },
    "human",
    { principal },
  );
  return { completesProject, slice: { ...slice, accepted: true, state: "done" } };
}

// --- Appetite (PM-P13-9) --------------------------------------------------------------

const OPEN: readonly CardStatus[] = [
  "backlog",
  "ready",
  "planning",
  "in_progress",
  "verify",
  "review",
  "parked",
];
const STARTED: readonly CardStatus[] = ["in_progress", "verify", "review", "done"];

/** The cards that trace to a slice's requirements (a rejected card does not count). */
export async function sliceCards(ledger: PlannerLedger, sliceId: string): Promise<CardRecord[]> {
  const ids = new Set<string>();
  for (const r of await ledger.store.requirements.bySlice(sliceId)) {
    for (const l of ledger.store.requirements.links(r.id)) if (l.from === "card") ids.add(l.ref);
  }
  const cards = await Promise.all([...ids].sort().map((id) => ledger.store.getCard(id)));
  return cards.filter(
    (c): c is CardRecord => c !== null && c !== undefined && c.status !== "rejected",
  );
}

/** Cards started and hours spent on a slice: a card counts once it ran or left the queue. */
export async function sliceUsage(
  ledger: PlannerLedger,
  sliceId: string,
): Promise<{ cards: number; hours: number }> {
  const cards = await sliceCards(ledger, sliceId);
  const outcomes = ledger.store.runs.readAttemptOutcomes();
  let seconds = 0;
  let started = 0;
  for (const c of cards) {
    const own = outcomes.filter((o) => o.cardId === c.id);
    seconds += own.reduce((n, o) => n + (o.secondsUsed ?? 0), 0);
    if (own.length > 0 || STARTED.includes(c.status)) started += 1;
  }
  return { cards: started, hours: Math.round((seconds / 3600) * 100) / 100 };
}

export interface AppetiteAsk {
  sliceId: string;
  projectId: string;
  title?: string;
  cards: number;
  hours: number;
  appetite: SliceAppetite;
  /** Accept as proven: only when the slice is proven. */
  accept: boolean;
  /** Named nice-to-haves that can be cut. */
  cut: { id: string; title?: string }[];
  /** Extend: only when every remaining card has red tests and nothing is unplanned. */
  extend: boolean;
  /** Why "extend" is not offered, when it is not. */
  noExtend?: string;
  /** Seshat's question, in plain words. */
  text: string;
}

/**
 * Stop a slice at its appetite (PM-P13-9): for each unaccepted slice whose
 * cards or hours reached its appetite, record `slice/appetite_reached` once
 * (again only after an extension), hold its open cards from scheduling, and
 * return the question for the person — accept as proven, cut named
 * nice-to-haves, or extend (offered only when every remaining card has red
 * tests and no requirement in the slice is unplanned). `asks` holds only the
 * slices that reached it on this pass; `held` every card not to schedule.
 */
export async function enforceAppetite(
  ledger: PlannerLedger,
  options: { mainSha?: string | undefined } = {},
): Promise<{ held: Set<string>; asks: AppetiteAsk[] }> {
  const held = new Set<string>();
  const asks: AppetiteAsk[] = [];
  for (const s of await ledger.store.slices.list()) {
    if (s.accepted) continue;
    const usage = await sliceUsage(ledger, s.id);
    const reached =
      (s.appetite.cards !== undefined && usage.cards >= s.appetite.cards) ||
      (s.appetite.hours !== undefined && usage.hours >= s.appetite.hours);
    if (!reached) continue;
    const cards = await sliceCards(ledger, s.id);
    const open = cards.filter((c) => OPEN.includes(c.status));
    for (const c of open) held.add(c.id);
    if (s.appetiteReached) continue;
    await ledger.store.slices.recordAppetiteReached({ sliceId: s.id, ...usage });
    const status = await sliceStatus(ledger, s.id, options.mainSha);
    const view = status?.slice;
    const cuttable = (view?.requirements ?? []).filter(
      (r) => !r.mustHave && r.state !== "cut" && r.state !== "proven",
    );
    const unred = open.filter(
      (c) =>
        c.status !== "in_progress" &&
        ledger.store.stagedTests.staged(c.id).length === 0 &&
        !c.acceptanceTests?.length,
    );
    const unplanned = (view?.requirements ?? []).filter((r) => r.state === "unplanned");
    const noExtend = unplanned.length
      ? `${unplanned.map((r) => r.id).join(", ")} ${unplanned.length === 1 ? "has" : "have"} no card`
      : unred.length
        ? `${unred.map((c) => c.id).join(", ")} ${unred.length === 1 ? "has" : "have"} no red test yet`
        : undefined;
    const accept = view?.state === "proven";
    const budget = [
      s.appetite.cards !== undefined ? `${usage.cards} of ${s.appetite.cards} cards` : undefined,
      s.appetite.hours !== undefined ? `${usage.hours} of ${s.appetite.hours} hours` : undefined,
    ]
      .filter(Boolean)
      .join(", ");
    const options_ = [
      accept ? "accept it as proven" : undefined,
      cuttable.length ? `cut ${cuttable.map((r) => r.id).join(", ")}` : undefined,
      noExtend === undefined ? "extend its appetite" : undefined,
    ].filter(Boolean);
    const text = `Slice ${s.id}${s.title ? ` (${s.title})` : ""} reached its appetite: ${budget}. Its cards are not scheduled until you choose: ${options_.length ? options_.join(", or ") : "revise it (nothing else is open to you)"}. ${view?.provenLine ?? ""}.${noExtend ? ` Extending is not offered: ${noExtend}.` : ""}`;
    asks.push({
      sliceId: s.id,
      projectId: s.projectId,
      ...(s.title !== undefined ? { title: s.title } : {}),
      ...usage,
      appetite: s.appetite,
      accept,
      cut: cuttable.map((r) => ({
        id: r.id,
        ...(r.title !== undefined ? { title: r.title } : {}),
      })),
      extend: noExtend === undefined,
      ...(noExtend !== undefined ? { noExtend } : {}),
      text: text.replace(/\s+\./g, ".").replace(/\.\./g, "."),
    });
  }
  return { held, asks };
}

// --- A revision and its impact (PM-P13-11, -12) -----------------------------------------

const HOLD_FROM: readonly CardStatus[] = ["ready", "verify", "review"];

/**
 * Hold every open card with a suspect link in Planning (PM-P13-11): a
 * ready, verifying or in-review card moves there with the revision named; a
 * running card is left to finish and is caught by the next sweep once it
 * stops. Returns the cards held.
 */
export async function holdSuspectCards(
  ledger: PlannerLedger,
  options: HoldOptions = {},
): Promise<string[]> {
  const held: string[] = [];
  const seen = new Set<string>();
  for (const r of await ledger.store.requirements.list()) {
    for (const l of ledger.store.requirements.links(r.id)) {
      if (l.from !== "card" || !l.suspect || seen.has(l.ref)) continue;
      const card = await ledger.store.getCard(l.ref);
      if (!card || !HOLD_FROM.includes(card.status)) continue;
      seen.add(card.id);
      const reason = `${r.id} was revised to version ${r.version}; the card traces to version ${l.version} and waits for a re-plan or a re-confirmation`;
      // PM-N9-9: in the Team setup an issue someone else owns gets the hold
      // as a suggestion to its owner, and stays as it was until applied.
      if (options.route?.(card) === "suggest") {
        await ledger.store.suggestions.propose({
          cardId: card.id,
          kind: "hold",
          value: reason,
          why: `${r.id} was revised; this issue was built against an earlier version. Apply to hold it in Planning for a re-plan or a re-confirmation.`,
        });
        continue;
      }
      await moveCard(ledger, { cardId: card.id, from: card.status, to: "planning", reason });
      held.push(card.id);
    }
  }
  return held;
}

/** Whether a hold changes a card or is posted to its owner (planner-pm §2.18.6, PM-N9-9). */
export interface HoldOptions {
  route?: (card: CardRecord) => "apply" | "suggest";
}

/** A proposed change card for a suspect done card (PM-P13-11). */
export interface ChangeCardDraft {
  cardId: string;
  requirementId: string;
  version: number;
  title: string;
  spec: string;
}

/**
 * Revise a requirement (PM-P13-11): `requirement/revised`, then its open
 * traced cards held in Planning, running ones left to finish, and a change
 * card drafted for each done card whose link is now suspect. Its slice is
 * unproven while any link is suspect (computed by `storyMap`).
 */
export async function reviseRequirement(
  ledger: PlannerLedger,
  id: string,
  revision: RequirementRevision,
  principal: string,
  options: HoldOptions = {},
): Promise<{ version: number; held: string[]; running: string[]; changeCards: ChangeCardDraft[] }> {
  if (!principal) throw new Error("A requirement is revised by a person; no principal was given");
  const version = await ledger.store.requirements.revise(id, revision, principal);
  const req = (await ledger.store.requirements.get(id)) as Requirement;
  const held = await holdSuspectCards(ledger, options);
  const running: string[] = [];
  const changeCards: ChangeCardDraft[] = [];
  for (const l of ledger.store.requirements.links(id)) {
    if (l.from !== "card" || !l.suspect) continue;
    const card = await ledger.store.getCard(l.ref);
    if (card?.status === "in_progress") running.push(card.id);
    if (card?.status === "done") {
      changeCards.push({
        cardId: card.id,
        requirementId: id,
        version,
        title: `Change ${card.title} for ${id} v${version}`,
        spec: `${id} was revised to version ${version}${req.title ? ` ("${req.title}")` : ""}. ${card.id} was done against version ${l.version}: change it so its behaviour meets version ${version}'s criteria${req.criteria.length ? ` (${req.criteria.map((c) => `${c.id}: ${c.text}`).join("; ")})` : ""}.`,
      });
    }
  }
  return { version, held, running, changeCards };
}

// --- A model's claim counts for nothing (PM-P13-6, -14) -------------------------------------

const CLAIM =
  /\b(?:project|slice|skeleton|release|version|milestone|mvp|product|app|backlog|scope|features?|requirements?|must-haves?|work|everything|it|this|we)\b[^.!?\n]{0,40}?\b(?:is|are|'s|'re|looks|seems)\s+(?:now\s+|all\s+|fully\s+)?(?:complete|completed|done|finished|ready\s+(?:to|for)\s+(?:ship|release)|ready|shippable|proven)\b|\bready\s+(?:to|for)\s+(?:ship|release)\b|\b(?:mark|marking|declare|declaring)\b[^.!?\n]{0,30}\b(?:complete|done|ready)\b|\ball\s+done\b/i;

/** Whether a model's message claims that a project, slice or release is complete or ready. */
export function claimsCompletion(text: string): boolean {
  return CLAIM.test(text);
}

/**
 * Seshat's reply when it claims completion (PM-P13-6, -14): the claim
 * changes nothing on the ledger, and while any must-have is unproven the
 * sentences making it are replaced by the proven count and what is
 * unproven. With no requirement recorded there is nothing to count, and
 * the text is left as it is.
 */
export function guardCompletionClaim(
  text: string,
  map: StoryMap | undefined,
): { text: string; guarded: boolean } {
  if (!map || map.slices.length === 0 || !claimsCompletion(text)) return { text, guarded: false };
  const unproven = map.slices.flatMap((s) =>
    s.requirements.filter((r) => r.mustHave && r.state !== "cut" && r.state !== "proven"),
  );
  const undone = map.slices.filter((s) => s.state !== "done");
  if (unproven.length === 0 && undone.length === 0 && map.projectDone) {
    return { text, guarded: false };
  }
  const kept = text
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((sentence) => sentence.trim() && !claimsCompletion(sentence))
    .join(" ")
    .trim();
  const lines = [
    `Not done: ${map.provenLine}.`,
    ...(unproven.length
      ? [`Unproven: ${unproven.map((r) => `${r.id} (${r.state.replace(/_/g, " ")})`).join(", ")}.`]
      : []),
    ...(unproven.length === 0 && undone.length
      ? [`Waiting for a person to accept: ${undone.map((s) => s.id).join(", ")}.`]
      : []),
    "Only tests passing on main and a person's acceptance mark a slice or a release done.",
  ];
  return { text: [kept, lines.join(" ")].filter(Boolean).join("\n\n"), guarded: true };
}

// --- Release per slice (PM-P13-10, -13, -14) ---------------------------------------------

/** Release notes from the slice's proven requirements, in the brief's words (§2.15.8). */
export function releaseNotes(
  version: string,
  proven: readonly { id: string; title?: string }[],
): string {
  return [
    `# ${version}`,
    "",
    "You can now:",
    ...proven.map((r) => `- ${r.title ?? r.id}`),
    "",
  ].join("\n");
}

export interface ReleaseReport {
  sliceId: string;
  baseline?: string;
  proven: { id: string; title?: string }[];
  cut: { id: string; title?: string }[];
  remaining: { id: string; title?: string; state: RequirementState }[];
  text: string;
}

/** The release report (PM-P13-10): proven, cut and remaining, against the brief's baseline. */
export function releaseReport(map: StoryMap, sliceId: string): ReleaseReport {
  const slice = map.slices.find((s) => s.id === sliceId);
  if (!slice) throw new Error(`No slice ${sliceId} in project ${map.projectId}`);
  const named = (r: RequirementView) => ({
    id: r.id,
    ...(r.title !== undefined ? { title: r.title } : {}),
  });
  const proven = slice.requirements.filter((r) => r.state === "proven").map(named);
  const cut = slice.requirements.filter((r) => r.state === "cut").map(named);
  const remaining = slice.requirements
    .filter((r) => r.state !== "proven" && r.state !== "cut")
    .map((r) => ({ ...named(r), state: r.state }));
  const item = (r: { id: string; title?: string }) => `- ${r.id}: ${r.title ?? ""}`.trimEnd();
  const text = [
    `Release report for ${slice.id}${slice.title ? ` (${slice.title})` : ""}: ${slice.provenLine}.`,
    `Compared with what you had before: ${map.baseline ?? "no baseline was stated in the brief"}.`,
    "Proven:",
    ...(proven.length ? proven.map(item) : ["- none"]),
    "Cut:",
    ...(cut.length ? cut.map(item) : ["- none"]),
    "Remaining:",
    ...(remaining.length
      ? remaining.map((r) => `${item(r)} (${r.state.replace(/_/g, " ")})`)
      : ["- none"]),
  ].join("\n");
  return {
    sliceId,
    ...(map.baseline !== undefined ? { baseline: map.baseline } : {}),
    proven,
    cut,
    remaining,
    text,
  };
}

/**
 * Propose the release of an accepted slice (PM-P13-13, -14): refused while
 * any must-have in it is unproven, whatever anyone said; its notes list the
 * slice's proven requirements in the brief's words, and the changelog is
 * the caller's grouping of the slice's squashes into Keep a Changelog's
 * categories.
 */
export async function proposeSliceRelease(
  ledger: PlannerLedger,
  input: {
    sliceId: string;
    version: string;
    changelog: Partial<Record<ChangelogCategory, string[]>>;
    mainSha?: string | undefined;
  },
): Promise<ReleaseProposal & { report: ReleaseReport }> {
  const status = await sliceStatus(ledger, input.sliceId, input.mainSha);
  if (!status) throw new Error(`No slice ${input.sliceId}`);
  const { map, slice } = status;
  if (slice.state !== "done") {
    throw new Error(
      slice.accepted
        ? `Slice ${slice.id} is no longer proven (${slice.provenLine}); no release is proposed: ${slice.blockers.join(" ")}`
        : `Slice ${slice.id} has not been accepted by a person (${slice.provenLine}); no release is proposed`,
    );
  }
  const report = releaseReport(map, slice.id);
  const version = input.version.replace(/^v/, "");
  const notes = releaseNotes(version, report.proven);
  const proposal = {
    sliceId: slice.id,
    version,
    requirementIds: report.proven.map((r) => r.id),
    changelog: input.changelog,
    notes,
  };
  await ledger.store.slices.proposeRelease(proposal);
  return { ...proposal, projectId: slice.projectId, report };
}
