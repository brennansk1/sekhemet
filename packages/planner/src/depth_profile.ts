import {
  type ChecklistRequirementText,
  type DepthProfile,
  type DepthProfileRecord,
  type QualityRow,
  checklistRowsFor,
} from "@sekhemet/kernel";
import { DESIGN_COPY as C } from "./design_copy.js";
import type { DesignStageResult, Proportion, RiskKind } from "./design_stage.js";
import type { PlannerLedger } from "./ledger.js";

/**
 * How deep to build (design-stage §2.8, P14): the depth profile the design
 * stage proposes with its reason and a person chooses (DS-P14-1, -3, -4); the
 * quality checklist's rows in words, each a requirement with an acceptance
 * criterion (DS-P14-2); comparable products found only when research is
 * allowed, with their common features proposed as must-be candidates citing
 * them (DS-P14-5, -9); and the story map walked once per named user role, each
 * step nothing supports proposed as a candidate (DS-P14-7). A candidate enters
 * the requirement graph only when a person accepts it (DS-P14-6, the kernel's
 * `candidates`). No model is loaded here: the rules propose, a person decides.
 */

export interface DepthProposal {
  profile: DepthProfile;
  /** Why, in a sentence a person reads; regulated says it claims no compliance (DS-P14-4). */
  reason: string;
}

const REGULATED =
  /\b(?:regulated|compliance|hipaa|gdpr|pci(?:[- ]dss)?|sox|fda|medical devices?|clinical trials?|banking|bank)\b/i;
const PROTOTYPE =
  /\b(?:prototype|demo|spike|proof of concept|poc|toy|mock-?up|hackathon|throwaway)\b/i;
const PUBLIC =
  /\b(?:customers?|website|web app|public|people can|users can|shop|storefront|marketplace|saas)\b/i;

/**
 * The profile to propose, and why (DS-P14-1): regulated when the request
 * names a regulated area; a prototype when it says so; production when money,
 * identity or personal data is at stake or people outside the team use it; a
 * prototype for a small new tool with nothing at stake (a calculator);
 * otherwise internal tool.
 */
export function proposeDepthProfile(
  spec: string,
  signals: { risk?: RiskKind; proportion?: Proportion; constraints?: number; questions?: number },
): DepthProposal {
  const regulated = REGULATED.exec(spec);
  if (regulated) return { profile: "regulated", reason: C.depth.regulated(regulated[0]) };
  if (PROTOTYPE.test(spec)) return { profile: "prototype", reason: C.depth.prototypeAsked };
  if (signals.risk) return { profile: "production", reason: C.depth[signals.risk] };
  if (PUBLIC.test(spec)) return { profile: "production", reason: C.depth.public };
  const small =
    (signals.proportion === "sentence" || signals.proportion === "none") &&
    !signals.constraints &&
    !signals.questions;
  if (small) return { profile: "prototype", reason: C.depth.prototype };
  return { profile: "internal tool", reason: C.depth.internal };
}

/** Each must-have row of a profile in words: a requirement with one criterion (DS-P14-2). */
export function checklistWordsFor(
  profile: DepthProfile,
): Partial<Record<QualityRow, ChecklistRequirementText>> {
  const out: Partial<Record<QualityRow, ChecklistRequirementText>> = {};
  for (const row of checklistRowsFor(profile)) {
    const w = C.checklist[row];
    out[row] = { title: w.title, criteria: [{ id: `QC-${row}`, text: w.criterion }] };
  }
  return out;
}

/**
 * Does a text state that a project complies with a standard or regulation?
 * Nothing Sekhemet writes may (DS-P14-4); saying it claims no compliance is
 * not a claim.
 */
export function claimsCompliance(text: string): boolean {
  return /\b(?:compl(?:ies|y) with|compliant with|(?:is|are|be|fully)\s+compliant|in compliance with|meets the (?:standard|regulation)|certified (?:as|under|for|to)|\w+[- ]compliant)\b/i.test(
    text,
  );
}

/**
 * Record a person's choice (DS-P14-1, -3) with what was proposed, and add a
 * requirement for each must-have checklist row not yet covered (DS-P14-2).
 * Returns what to say: the rows added, and for regulated that it claims no
 * compliance (DS-P14-4).
 */
export async function recordDepthChoice(
  ledger: PlannerLedger,
  input: { profile: DepthProfile; projectId?: string; proposal?: DepthProposal },
  principal: string,
): Promise<{ record: DepthProfileRecord; requirementIds: string[]; lines: string[] }> {
  const { record, checklistRequirementIds } = await ledger.store.depthProfiles.choose(
    {
      profile: input.profile,
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      ...(input.proposal
        ? { proposed: input.proposal.profile, reason: input.proposal.reason }
        : {}),
      checklist: checklistWordsFor(input.profile),
    },
    principal,
  );
  return {
    record,
    requirementIds: checklistRequirementIds,
    lines: [
      C.offer.chosen(input.profile, checklistRequirementIds.length),
      ...(input.profile === "regulated" ? [C.depth.regulatedNote] : []),
    ],
  };
}

// --- Comparables (DS-P14-5, -9) ---------------------------------------------

/** A comparable project or product: its name, where it was found, and its features. */
export interface Comparable {
  name: string;
  url: string;
  features: string[];
}

/** The search the harness wires through the research consent; absent when research is off. */
export type ComparablesSearch = (query: string) => Promise<Comparable[]>;

export interface ComparableFeature {
  feature: string;
  foundIn: number;
  of: number;
  sources: { label: string; url: string }[];
}

const STOP = new Set(
  "a an the my our your their this that some its of to in on for with and or by from".split(" "),
);
/** Words that say what kind of thing is built, not what it is about. */
const GENERIC = new Set(
  "cli tool tools app apps application service services script program system library lib".split(
    " ",
  ),
);
/** A change to an existing product, not a kind of product. */
const CHANGE =
  /^(?:add|fix|change|update|remove|rename|refactor|support|make|improve|move|delete|bump|upgrade|let|allow)\b/i;
/** Topics that name a technology or a list, not a feature. */
const NOT_FEATURES = new Set(
  "typescript javascript python go golang rust java kotlin swift php ruby c cpp csharp dart flutter react vue angular svelte nextjs nodejs node django flask fastapi rails laravel spring docker kubernetes hacktoberfest awesome open source opensource app application cli website web api library framework".split(
    " ",
  ),
);

const RELATIVE = /\s+(?:that|which|where|who|so that|to let|for|with)\s+/i;
const wordsOf = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
const stem4 = (w: string) => w.slice(0, 4);

/**
 * The short keyword query for comparables — the kind of product, never the
 * spec (§2.5.2): "a recipe website where…" is "recipe website". A change to
 * an existing product names no kind, and is not searched.
 */
export function comparablesQuery(buildSpec: string): string | undefined {
  const first = buildSpec.split(/(?<=[.!?])\s+/)[0] ?? buildSpec;
  if (CHANGE.test(first.trim())) return undefined;
  const rel = RELATIVE.exec(first);
  const head = wordsOf(rel ? first.slice(0, rel.index) : first);
  const kind = head.filter((w) => !GENERIC.has(w));
  if (kind.length > 0) return kind.slice(0, 3).join(" ");
  if (head.length === 0) return undefined;
  const rest = rel ? wordsOf(first.slice(rel.index + rel[0].length)) : [];
  return [...head, ...rest].slice(0, 3).join(" ");
}

/**
 * The features comparables share, each counted once per comparable, with the
 * comparables it was found in (DS-P14-5). A feature in one comparable, the
 * product's own kind, and a technology are not features.
 */
export function commonFeatures(
  comparables: readonly Comparable[],
  query: string,
): ComparableFeature[] {
  const of = comparables.length;
  if (of < 2) return [];
  const own = new Set(wordsOf(query).map(stem4));
  const found = new Map<string, Comparable[]>();
  for (const c of comparables) {
    const mine = new Set(
      c.features
        .map((f) => f.toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim())
        .filter((f) => f && !NOT_FEATURES.has(f) && !NOT_FEATURES.has(f.replace(/\s+/g, "")))
        .filter((f) => !wordsOf(f).every((w) => own.has(stem4(w)))),
    );
    for (const f of mine) found.set(f, [...(found.get(f) ?? []), c]);
  }
  return [...found.entries()]
    .filter(([, cs]) => cs.length >= 2)
    .map(([feature, cs]) => ({
      feature,
      foundIn: cs.length,
      of,
      sources: cs.map((c) => ({ label: c.name, url: c.url })),
    }))
    .sort((a, b) => b.foundIn - a.foundIn || a.feature.localeCompare(b.feature));
}

const capital = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;

/**
 * Comparables for the product the request names (DS-P14-5, -9): with no
 * search — research off — it says they were not searched and that the
 * checklist and conversation are not complete coverage; a search that fails
 * is not searched, never "nothing found". Otherwise each comparable is listed
 * with its source, and each feature two or more share is proposed as a
 * candidate citing them — must-be when at least half have it. A candidate
 * already proposed for the project is not proposed again.
 */
export async function surveyComparables(
  ledger: PlannerLedger,
  input: {
    projectId?: string;
    buildSpec: string;
    search?: ComparablesSearch;
    /** Why there is no search: the research consent's answer. */
    notSearched?: string;
  },
): Promise<{ lines: string[]; comparables: Comparable[]; candidateIds: string[] }> {
  const query = comparablesQuery(input.buildSpec);
  if (!query) return { lines: [], comparables: [], candidateIds: [] };
  if (!input.search) {
    return {
      lines: [C.comparables.notSearched(input.notSearched ?? "research is off")],
      comparables: [],
      candidateIds: [],
    };
  }
  let comparables: Comparable[];
  try {
    comparables = await input.search(query);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return {
      lines: [C.comparables.notSearched(`"${query}" could not be searched (${why})`)],
      comparables: [],
      candidateIds: [],
    };
  }
  if (comparables.length === 0) {
    return { lines: [C.comparables.none(query)], comparables, candidateIds: [] };
  }
  const lines = [
    C.comparables.found(comparables.length, query),
    ...comparables.map((c) => C.comparables.item(c.name, c.url)),
  ];
  if (comparables.length < 2) lines.push(C.comparables.tooFew);
  const existing = new Set(
    (await ledger.store.candidates.list(input.projectId ? { projectId: input.projectId } : {}))
      .filter((c) => c.source === "comparable")
      .map((c) => (c.title ?? "").toLowerCase()),
  );
  const candidateIds: string[] = [];
  for (const f of commonFeatures(comparables, query)) {
    const title = capital(f.feature);
    if (existing.has(title.toLowerCase())) continue;
    candidateIds.push(
      await ledger.store.candidates.propose({
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
        source: "comparable",
        title,
        sources: f.sources,
        comparables: { foundIn: f.foundIn, of: f.of },
      }),
    );
    lines.push(C.comparables.common(title, f.foundIn, f.of));
  }
  return { lines, comparables, candidateIds };
}

// --- The walkthrough (DS-P14-7) ---------------------------------------------

const WALK_STOP = new Set(
  "a an the can to of and or for with on at by they their them it its what when something after again later visit nothing yet has have be is are was were from this that who which as".split(
    " ",
  ),
);
const stepStems = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !WALK_STOP.has(w))
    .map(stem4);

const SAVING =
  /\b(?:save|saves|saved|saving|favourite|favorite|bookmark|store|stores|keep|keeps|collect)\w*/i;

/** The steps one role takes: what the request says it does, then where users get stuck. */
function stepsFor(design: DesignStageResult, role: string, single: boolean): string[] {
  const own = design.actions.filter((a) => a.role === role || (single && a.role === undefined));
  const implied = [
    ...(design.risk === "identity" ? C.implied.identity : []),
    ...(SAVING.test(design.buildSpec) ? C.implied.saving : []),
    ...(design.risk === "money" ? C.implied.money : []),
    ...C.implied.always,
  ];
  return [...new Set([...own.map((a) => a.text), ...implied])].map((t) =>
    C.walkthrough.step(role, t),
  );
}

/**
 * Walk the story map once per named user role (DS-P14-7) — only once it
 * exists (the project has slices), and never twice for a role. Each step
 * cites the requirements whose words cover it; the kernel proposes each step
 * with none as a candidate.
 */
export async function walkStoryMap(
  ledger: PlannerLedger,
  input: { projectId: string; design: DesignStageResult },
): Promise<{
  walks: { role: string; walkthroughId: string; candidateIds: string[] }[];
  lines: string[];
}> {
  const { store } = ledger;
  if ((await store.slices.list(input.projectId)).length === 0) return { walks: [], lines: [] };
  const requirements = (await store.requirements.list({ projectId: input.projectId })).filter(
    (r) => !r.cut,
  );
  const covers = requirements.map((r) => ({
    id: r.id,
    stems: new Set(stepStems(`${r.title ?? ""} ${r.criteria.map((c) => c.text).join(" ")}`)),
  }));
  const walked = new Set(
    (await store.candidates.walkthroughs(input.projectId)).map((w) =>
      (w.role ?? "").trim().toLowerCase(),
    ),
  );
  const roles = input.design.roles.length > 0 ? input.design.roles : ["user"];
  const walks: { role: string; walkthroughId: string; candidateIds: string[] }[] = [];
  const lines: string[] = [];
  for (const role of roles) {
    if (walked.has(role)) continue;
    const texts = stepsFor(input.design, role, roles.length === 1);
    const steps = texts.map((text, i) => {
      // The role's own word is not what the step does.
      const own = stepStems(text).filter((s) => s !== stem4(role));
      const requirementIds = own.length
        ? covers.filter((c) => own.every((s) => c.stems.has(s))).map((c) => c.id)
        : [];
      return { id: `s${i + 1}`, text, requirementIds };
    });
    const out = await store.candidates.recordWalkthrough({
      projectId: input.projectId,
      role,
      steps,
    });
    walks.push({ role, ...out });
    lines.push(C.walkthrough.walked(role, steps.length, out.candidateIds.length));
  }
  return { walks, lines };
}
