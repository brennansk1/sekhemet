import { createHash } from "node:crypto";
import type { CardRecord, CardTier } from "@sekhemet/kernel";
import type { InferenceRequest, LocalInferenceAdapter } from "@sekhemet/models";
import { DEFAULT_MAX_SPLIT_DEPTH, DEFAULT_TIER_BUDGET, MAX_SCOPE_FILES } from "./constants.js";
import { routeByDifficulty, scoreDifficulty, stepBudgetForDifficulty } from "./difficulty.js";
import { validateInvest } from "./invest.js";
import { acceptanceTestPath, estimatePackTokens, selectScopeFiles } from "./scope.js";
import {
  contentWords,
  matchPhrases,
  sentenceCase,
  splitClauses,
  stripLeadVerb,
  tokenize,
} from "./text.js";
import type {
  AcceptanceTestSpec,
  AmbiguityFinding,
  CapabilityCeiling,
  CodebaseMap,
  DecomposeSpecParams,
  EditSketch,
  PlannedStory,
  SpidrSliceKind,
  SpikeProposal,
  StoryValueLink,
  TierBudget,
} from "./types.js";

/**
 * Tier of the children a card of each tier produces.
 *
 * Splitting a story yields more stories, not sub-tasks: a SPIDR split is a
 * vertical slice, and each slice has to be independently shippable to be worth
 * making. Only a story that is already the smallest shippable thing degrades
 * into tasks.
 */
const CHILD_TIER: Record<CardTier, CardTier> = {
  initiative: "epic",
  epic: "story",
  feature: "story",
  story: "story",
  task: "task",
};

/** Slice order is execution order; dependencies are derived from it. */
const SLICE_ORDER: SpidrSliceKind[] = ["spike", "interface", "data", "path", "rule"];

const INTERFACE_SIGNALS = [
  "interface",
  "type",
  "types",
  "schema",
  "contract",
  "api",
  "endpoint",
  "signature",
  "dto",
  "protocol",
  "shape",
  "surface",
] as const;

const DATA_SIGNALS = [
  "store",
  "storage",
  "persist",
  "persistence",
  "database",
  "table",
  "column",
  "record",
  "records",
  "row",
  "rows",
  "migration",
  "index",
  "query",
  "cache",
  "batch",
  "batching",
  "serialize",
  "entity",
  "cookie",
  "cookies",
  "session",
  "sessions",
] as const;

const RULE_SIGNALS = [
  "validate",
  "validation",
  "authz",
  "authorization",
  "authentication",
  "authenticate",
  "auth",
  "permission",
  "permissions",
  "rate",
  "limiting",
  "limit",
  "quota",
  "policy",
  "enforce",
  "invariant",
  "constraint",
  "sanitize",
  "audit",
  "acl",
  "role",
  "roles",
  "hashing",
  "hash",
  "encrypt",
  "encryption",
] as const;

/**
 * Failure modes that become their own Path slice.
 *
 * The design is explicit that the happy path ships first and these spin off
 * (§690-700): a card that must make the feature work *and* survive a timeout
 * is a card whose failure tells you nothing about which half broke.
 */
const HAZARD_SIGNALS = [
  "retry",
  "retries",
  "timeout",
  "timeouts",
  "network",
  "offline",
  "failure",
  "failures",
  "error",
  "errors",
  "boundary",
  "edge",
  "cancel",
  "cancellation",
  "resume",
  "recovery",
  "concurrent",
  "concurrency",
  "race",
  "degraded",
  "backpressure",
] as const;

interface SliceProposal {
  kind: SpidrSliceKind;
  title: string;
  keywords: string[];
  rationale: string;
  hazardCount: number;
  /**
   * One sentence a test can check. Without it every card's criterion was
   * "<title> is observable through the exported surface of <file>", which an
   * empty export satisfies.
   */
  behaviour?: string;
  /** A hard invariant or the riskiest assumption: proven right after the contract. */
  early?: boolean;
}

interface Capability {
  text: string;
  keywords: string[];
}

function deterministicId(seed: string, slice: SpidrSliceKind, tier: CardTier): string {
  const digest = createHash("sha256").update(seed).digest("hex").slice(0, 8);
  return `${tier}_${slice}_${digest}`;
}

/** Break a spec into the capabilities it actually enumerates. */
export function deriveCapabilities(spec: string): Capability[] {
  const seen = new Set<string>();
  const capabilities: Capability[] = [];
  for (const clause of splitClauses(spec)) {
    const text = stripLeadVerb(clause);
    const keywords = contentWords(text);
    if (keywords.length === 0) {
      continue;
    }
    const key = keywords.join(" ");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    capabilities.push({ text, keywords });
  }
  return capabilities;
}

/**
 * A hard invariant — "must never charge twice", "exactly once", idempotent —
 * is a rule, and unlike a validation rule it is proven early: it decides the
 * shape of the code that must keep it.
 */
const INVARIANT = /\b(?:never|twice|idempoten\w*|exactly once|at most once|must not)\b/i;

function classifyCapability(capability: Capability): SpidrSliceKind {
  const tokens = tokenize(capability.text);
  if (INVARIANT.test(capability.text) || matchPhrases(tokens, RULE_SIGNALS).length > 0) {
    return "rule";
  }
  if (matchPhrases(tokens, DATA_SIGNALS).length > 0) {
    return "data";
  }
  if (matchPhrases(tokens, INTERFACE_SIGNALS).length > 0) {
    return "interface";
  }
  return "path";
}

function titleFor(kind: SpidrSliceKind, capability: string): string {
  const subject = sentenceCase(capability);
  switch (kind) {
    case "spike":
      return `Spike: resolve ${capability}`;
    case "interface":
      return `${subject}: types and contracts first`;
    case "data":
      return `${subject}: single-entity persistence`;
    case "path":
      return `${subject}: happy path`;
    case "rule":
      return `${subject}: enforce the rule`;
  }
}

function rationaleFor(kind: SpidrSliceKind, capability: string): string {
  switch (kind) {
    case "spike":
      return `Uncertainty in "${capability}" can only be settled by running code; settle it before any card commits to a shape.`;
    case "interface":
      return `Fixing the types for "${capability}" first makes every later slice fail at compile time instead of at runtime.`;
    case "data":
      return `Persist one entity of "${capability}" before batching or nesting; the single-entity case is where the schema is decided.`;
    case "path":
      return `Ship the happy path of "${capability}" alone, so a failure names the feature rather than its error handling.`;
    case "rule":
      return `Enforce "${capability}" on a path that already works; relaxed validation first, hardening second.`;
  }
}

/**
 * Turn a spec into slice proposals covering all five SPIDR kinds.
 *
 * Interface and Path are guaranteed when the spec introduces any behaviour:
 * every feature has a surface and a happy path, even when the prose only
 * describes rules. Spike, Data and Rule appear only when the spec earns them.
 */
export function proposeSlices(
  spec: string,
  spikes: readonly SpikeProposal[] = [],
  options: { riskiest?: string } = {},
): SliceProposal[] {
  const capabilities = deriveCapabilities(spec);
  const specTokens = tokenize(spec);
  const proposals: SliceProposal[] = [];

  for (const spike of spikes) {
    proposals.push({
      kind: "spike",
      title: titleFor("spike", spike.topic),
      keywords: contentWords(spike.topic),
      rationale: rationaleFor("spike", spike.topic),
      hazardCount: 0,
    });
  }

  for (const capability of capabilities) {
    const kind = classifyCapability(capability);
    proposals.push({
      kind,
      title: titleFor(kind, capability.text),
      keywords: capability.keywords,
      rationale: rationaleFor(kind, capability.text),
      hazardCount: 0,
      behaviour: behaviourFor(kind, capability.text),
      ...(kind === "rule" && INVARIANT.test(capability.text) ? { early: true } : {}),
    });
  }

  const headline = capabilities[0]?.text ?? spec.trim();
  if (!proposals.some((p) => p.kind === "interface")) {
    proposals.unshift({
      kind: "interface",
      title: titleFor("interface", headline),
      keywords: contentWords(headline),
      rationale: rationaleFor("interface", headline),
      hazardCount: 0,
      behaviour: behaviourFor("interface", headline),
    });
  }
  if (!proposals.some((p) => p.kind === "path")) {
    proposals.push({
      kind: "path",
      title: titleFor("path", headline),
      keywords: contentWords(headline),
      rationale: rationaleFor("path", headline),
      hazardCount: 0,
      behaviour: behaviourFor("path", headline),
    });
  }

  /** Each named failure mode becomes its own Path slice, after the happy path. */
  for (const hazard of matchPhrases(specTokens, HAZARD_SIGNALS)) {
    const subject = `${hazard.phrase} handling for ${headline}`;
    if (proposals.some((p) => p.keywords.includes(hazard.phrase) && p.kind === "path")) {
      continue;
    }
    proposals.push({
      kind: "path",
      title: `${sentenceCase(headline)}: ${hazard.phrase} handling`,
      keywords: [...contentWords(headline), hazard.phrase],
      rationale: rationaleFor("path", subject),
      hazardCount: 1,
    });
  }

  return orderSlices(withRiskiest(proposals, options.riskiest));
}

/**
 * The heuristic's behaviour sentence: the spec's own words for what must
 * happen, which is weaker than a model's Given/When/Then and far stronger
 * than a sentence about the card's own title.
 */
function behaviourFor(kind: SpidrSliceKind, capability: string): string {
  const said = sentenceCase(capability.trim().replace(/\.$/, ""));
  switch (kind) {
    case "interface":
      return `The types ${capability} works with are exported, and a test can construct a value of each.`;
    case "rule":
      return `${said}: a test performs the forbidden case and observes that it does not happen.`;
    default:
      return `${said}: a test calls the exported API and observes it happen, as the spec states it.`;
  }
}

/** Spikes, then the contract, then what must never break, then the rest. */
function orderSlices(proposals: SliceProposal[]): SliceProposal[] {
  const rank = (p: SliceProposal) => (p.early ? 1.5 : SLICE_ORDER.indexOf(p.kind));
  return proposals.sort((a, b) => rank(a) - rank(b));
}

/**
 * The riskiest assumption becomes a card proven right after the contract,
 * even when the spec never states it (design: "it becomes the first card").
 */
function withRiskiest(proposals: SliceProposal[], riskiest: string | undefined): SliceProposal[] {
  if (!riskiest) return proposals;
  // "A charge is correct and happens once: a retried request must never…"
  const claim = (riskiest.split(":").slice(1).join(":").trim() || riskiest).replace(/\.$/, "");
  const keywords = contentWords(claim);
  const existing = proposals.find(
    (p) => p.kind === "rule" && keywords.filter((k) => p.keywords.includes(k)).length >= 2,
  );
  if (existing) {
    existing.early = true;
    existing.title = `Riskiest assumption — ${existing.title}`;
    return proposals;
  }
  return [
    ...proposals,
    {
      kind: "rule",
      title: `Riskiest assumption — ${sentenceCase(claim)}`,
      keywords,
      rationale:
        "The thing most likely to make this not work is proven before anything is built on it.",
      hazardCount: 0,
      behaviour: behaviourFor("rule", claim),
      early: true,
    },
  ];
}

function acceptanceFor(
  proposal: SliceProposal,
  scopeFiles: readonly string[],
  testPath: string,
): AcceptanceTestSpec[] {
  const target = scopeFiles[0] ?? "the card's scope";
  const tests: AcceptanceTestSpec[] = [
    {
      filePath: testPath,
      assertion:
        proposal.behaviour ??
        `${sentenceCase(proposal.title)} is observable through the exported surface of ${target}.`,
      initiallyFailing: true,
    },
  ];
  if (proposal.kind === "rule") {
    tests.push({
      filePath: testPath,
      assertion: `Input that violates ${proposal.keywords.join(" ")} is rejected, and the rejection names the rule.`,
      initiallyFailing: true,
    });
  }
  if (proposal.hazardCount > 0) {
    tests.push({
      filePath: testPath,
      assertion: `The named failure mode is handled without losing work already committed by ${target}.`,
      initiallyFailing: true,
    });
  }
  return tests;
}

function editSketchFor(
  cardId: string,
  proposal: SliceProposal,
  scopeFiles: readonly string[],
  symbols: readonly string[],
): EditSketch {
  return {
    cardId,
    targetSymbols: scopeFiles.map((filePath, index) => ({
      filePath,
      symbol: symbols[index] ?? `${proposal.keywords.slice(0, 2).join("_") || "feature"}`,
      change: symbols[index] === undefined ? "add" : "modify",
    })),
    preconditions: [
      "The acceptance tests for this card exist and fail for the stated reason.",
      "No file outside the card's scope is modified.",
    ],
    invariants: [
      "Existing exported signatures keep their shape unless this card's title says otherwise.",
      "No gate is relaxed to make this card pass.",
    ],
    diffSketch: `${proposal.rationale} Change is confined to ${scopeFiles.join(", ")}; ${proposal.kind} slice, so the visible effect is ${proposal.kind === "interface" ? "new or changed type declarations" : "new behaviour behind the existing surface"}.`,
    blastRadius: [...scopeFiles],
  };
}

interface BuildStoryParams {
  proposal: SliceProposal;
  parentId: string;
  tier: CardTier;
  index: number;
  map: CodebaseMap | undefined;
  budget: TierBudget;
  taken: Set<string>;
  dependsOn: string[];
  advances: StoryValueLink[];
  unknownCount: number;
  now: string;
  splitFrom?: string;
  splitDepth: number;
  /** Extra id entropy so a split child never collides with another branch. */
  idSeed?: string;
}

function buildStory(params: BuildStoryParams): PlannedStory {
  const { proposal, map, budget, taken } = params;
  const selection = selectScopeFiles(
    proposal.kind,
    proposal.keywords,
    map,
    taken,
    Math.min(budget.maxFiles, MAX_SCOPE_FILES),
  );
  for (const file of selection.files) {
    taken.add(file);
  }

  const id = deterministicId(
    `${params.idSeed ?? params.parentId}:${proposal.kind}:${proposal.keywords.join("_")}:${params.index}:${params.splitDepth}`,
    proposal.kind,
    params.tier,
  );
  /** Test paths share the `taken` set so two slices never claim one spec file. */
  const basePath = acceptanceTestPath(proposal.kind, proposal.keywords, map);
  let testPath = basePath;
  let suffix = 2;
  while (taken.has(testPath)) {
    testPath = basePath.replace(/\.spec\.ts$/, `_${suffix}.spec.ts`);
    suffix += 1;
  }
  taken.add(testPath);
  const acceptanceTests = acceptanceFor(proposal, selection.files, testPath);

  const difficulty = scoreDifficulty({
    slice: proposal.kind,
    fileCount: selection.files.length,
    symbolCount: selection.symbols.length,
    hazardCount: proposal.hazardCount,
    unknownCount: params.unknownCount,
    crossPackage: new Set(selection.files.map((f) => f.split("/").slice(0, 2).join("/"))).size > 1,
  });
  const routing = routeByDifficulty(difficulty.value);
  const stepBudget = stepBudgetForDifficulty(difficulty.value);

  const card: CardRecord = {
    id,
    tier: params.tier,
    parentId: params.parentId,
    title: proposal.title,
    /** Only the first slice is ready; the rest wait on their dependencies. */
    status: params.dependsOn.length === 0 ? "ready" : "backlog",
    scopeFiles: selection.files,
    stepBudget,
    stepsUsed: 0,
    createdAt: params.now,
    updatedAt: params.now,
  };

  return {
    card,
    slice: proposal.kind,
    rationale: proposal.rationale,
    keywords: proposal.keywords,
    acceptanceTests,
    advances: params.advances,
    difficulty,
    routing,
    dependsOn: params.dependsOn,
    estimatedPackTokens: estimatePackTokens(
      selection.files,
      acceptanceTests.map((t) => t.filePath),
      `${proposal.title} ${proposal.rationale}`,
      map,
    ),
    ...(params.splitFrom !== undefined ? { splitFrom: params.splitFrom } : {}),
    splitDepth: params.splitDepth,
    ...(routing === "edit_sketch"
      ? { editSketch: editSketchFor(id, proposal, selection.files, selection.symbols) }
      : {}),
  };
}

/**
 * Split one oversized story into narrower ones.
 *
 * Splits along whichever axis the story actually has: separate files first
 * (the children are then genuinely independent), then separate capabilities,
 * then separate assertions. Returns `undefined` when no axis has more than one
 * value, or when the children come out no smaller than their parent — that
 * story has hit a capability ceiling, and saying so is more useful than
 * recursing on copies of it until the depth cap runs out.
 */
export function splitStory(
  story: PlannedStory,
  map: CodebaseMap | undefined,
  budget: TierBudget,
  taken: Set<string>,
  advances: StoryValueLink[],
  now: string,
): PlannedStory[] | undefined {
  const axes: { keywords: string[]; label: string }[] = [];

  if (story.card.scopeFiles.length > 1) {
    for (const file of story.card.scopeFiles) {
      const stem =
        file
          .split("/")
          .pop()
          ?.replace(/\.[^.]+$/, "") ?? file;
      axes.push({ keywords: contentWords(stem.replace(/[_-]/g, " ")), label: stem });
    }
  } else if (story.keywords.length > 1) {
    const midpoint = Math.ceil(story.keywords.length / 2);
    axes.push({ keywords: story.keywords.slice(0, midpoint), label: "first half" });
    axes.push({ keywords: story.keywords.slice(midpoint), label: "second half" });
  } else if (story.acceptanceTests.length > 1) {
    for (const [index, test] of story.acceptanceTests.entries()) {
      axes.push({
        keywords: contentWords(test.assertion).slice(0, 3),
        label: `assertion ${index}`,
      });
    }
  }

  const usable = axes.filter((axis) => axis.keywords.length > 0);
  if (usable.length < 2) {
    return undefined;
  }

  /**
   * The split is trialled against a copy of the claimed-files set, so a split
   * that turns out not to help leaves no reservations behind.
   */
  const trial = new Set(taken);
  for (const file of story.card.scopeFiles) {
    trial.delete(file);
  }

  const children: PlannedStory[] = [];
  for (const [index, axis] of usable.entries()) {
    const previous = children[index - 1];
    const child = buildStory({
      proposal: {
        kind: story.slice,
        title: `${story.card.title} — ${axis.label}`,
        keywords: axis.keywords,
        rationale: `${story.rationale} Split from ${story.card.id}: the parent exceeded its tier budget.`,
        hazardCount: 0,
      },
      parentId: story.card.parentId ?? story.card.id,
      tier: story.card.tier,
      index,
      map,
      budget,
      taken: trial,
      idSeed: story.card.id,
      /**
       * Children carved out of a single file share it, so they are serialized
       * rather than left to collide; children with a file each stay parallel.
       */
      dependsOn:
        story.card.scopeFiles.length > 1 || previous === undefined
          ? story.dependsOn
          : [previous.card.id],
      advances,
      unknownCount: 0,
      now,
      splitFrom: story.card.id,
      splitDepth: story.splitDepth + 1,
    });
    children.push(child);
  }

  /**
   * A split has to buy something. Children that are no cheaper than the parent
   * mean the cost is in the slice itself, not in its breadth — recursing on
   * them produces near-duplicates and still does not fit.
   */
  const madeProgress = children.every(
    (child) =>
      child.card.stepBudget < story.card.stepBudget ||
      child.estimatedPackTokens < story.estimatedPackTokens,
  );
  const distinct = new Set(children.map((child) => child.card.id)).size === children.length;
  if (!madeProgress || !distinct) {
    return undefined;
  }

  taken.clear();
  for (const file of trial) {
    taken.add(file);
  }
  return children;
}

export interface DecomposeInternalParams extends DecomposeSpecParams {
  findings: readonly AmbiguityFinding[];
  spikes: readonly SpikeProposal[];
  adapter?: LocalInferenceAdapter;
  now?: Date;
}

export interface DecomposeInternalResult {
  stories: PlannedStory[];
  capabilityCeilings: CapabilityCeiling[];
  source: "heuristic" | "model_assisted";
}

/**
 * Slice, then split until every leaf fits.
 *
 * The loop is the point: a first pass that produces one oversized story is
 * normal, and the design requires splitting until the leaves fit the tier's
 * context and step budget rather than handing the oversized card over with a
 * warning attached.
 */
export async function decomposeSpidr(
  params: DecomposeInternalParams,
): Promise<DecomposeInternalResult> {
  const budget = params.tierBudget ?? DEFAULT_TIER_BUDGET;
  const tier = CHILD_TIER[params.parentTier ?? "epic"];
  const now = (params.now ?? new Date()).toISOString();
  const maxDepth = params.maxSplitDepth ?? DEFAULT_MAX_SPLIT_DEPTH;

  const advances: StoryValueLink[] = [
    ...(params.gateIds ?? ["typecheck", "unit"]).map(
      (ref): StoryValueLink => ({ kind: "gate", ref }),
    ),
    ...(params.goalCriteriaIds ?? []).map((ref): StoryValueLink => ({ kind: "criterion", ref })),
  ];

  const modelProposals =
    params.adapter === undefined
      ? undefined
      : await proposeSlicesWithModel(params.adapter, params.spec, params.codebaseMap);
  const proposals = modelProposals
    ? orderSlices(withRiskiest(modelProposals, params.riskiest))
    : proposeSlices(
        params.spec,
        params.spikes,
        params.riskiest ? { riskiest: params.riskiest } : {},
      );
  const source = modelProposals === undefined ? "heuristic" : "model_assisted";

  const taken = new Set<string>();
  const byKind = new Map<SpidrSliceKind, string[]>();
  let stories: PlannedStory[] = [];

  for (const [index, proposal] of proposals.entries()) {
    const dependsOn = nearestPredecessorIds(proposal.kind, byKind);
    const story = buildStory({
      proposal,
      parentId: params.parentId,
      tier,
      index,
      map: params.codebaseMap,
      budget,
      taken,
      dependsOn,
      advances,
      unknownCount: params.findings.filter((f) => f.disposition === "ask").length,
      now,
      splitDepth: 0,
    });
    stories.push(story);
    byKind.set(proposal.kind, [...(byKind.get(proposal.kind) ?? []), story.card.id]);
  }

  const capabilityCeilings: CapabilityCeiling[] = [];
  /** A story that cannot be split is not retried; the ceiling is reported once. */
  const ceilinged = new Set<string>();

  for (let depth = 0; depth < maxDepth; depth += 1) {
    const report = validateInvest(stories, { tierBudget: budget, specText: params.spec });
    const pending = new Set(report.mustResplit);
    if (pending.size === 0) {
      break;
    }

    let changed = false;
    const next: PlannedStory[] = [];
    for (const story of stories) {
      if (!pending.has(story.card.id) || ceilinged.has(story.card.id)) {
        next.push(story);
        continue;
      }
      const children = splitStory(story, params.codebaseMap, budget, taken, advances, now);
      if (children === undefined) {
        ceilinged.add(story.card.id);
        capabilityCeilings.push({
          storyId: story.card.id,
          reason: `"${story.card.title}" still exceeds the tier budget (difficulty ${story.difficulty.value}, ${story.estimatedPackTokens} pack tokens, ${story.card.stepBudget} steps) and has no remaining axis to split on.`,
          smallestHumanAction: `Name the one behaviour of "${story.card.title}" to ship first, or point the planner at the file it should change.`,
        });
        next.push(story);
        continue;
      }
      next.push(...children);
      changed = true;
    }

    stories = next;
    if (!changed) {
      break;
    }
  }

  return { stories, capabilityCeilings, source };
}

/** Depend on the nearest preceding slice kind that exists, not on all of them. */
function nearestPredecessorIds(
  kind: SpidrSliceKind,
  byKind: ReadonlyMap<SpidrSliceKind, string[]>,
): string[] {
  const position = SLICE_ORDER.indexOf(kind);
  for (let i = position - 1; i >= 0; i -= 1) {
    const earlier = SLICE_ORDER[i];
    const ids = earlier === undefined ? undefined : byKind.get(earlier);
    if (ids !== undefined && ids.length > 0) {
      return [...ids];
    }
  }
  return [];
}

/* -------------------------------------------------------------------------- */
/* Optional model assistance                                                  */
/* -------------------------------------------------------------------------- */

const SLICE_KINDS = new Set<string>(SLICE_ORDER);

/** Balanced-brace scan; a model's JSON is usually wrapped in prose. */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) {
    return undefined;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text.charAt(i);
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1)) as unknown;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

const SLICE_PROMPT = [
  "Decompose the specification into SPIDR vertical slices.",
  "Kinds: spike (technical uncertainty), interface (types and contracts), data (persistence),",
  "path (happy path, then one slice per named failure mode), rule (validation, authz, limits).",
  "Every slice must be independently shippable and touch at most three files.",
  "For each slice give a behaviour: one sentence a test can check, with concrete values — Given ..., when ..., then ....",
  'Reply with JSON only: {"slices":[{"kind":"interface","title":"...","keywords":["..."],"rationale":"...","behaviour":"..."}]}',
].join(" ");

/**
 * Ask a local model for slices, and treat its answer as a proposal.
 *
 * The model never gets the last word: whatever it returns is re-costed, run
 * through INVEST-S and split like any heuristic slice. Anything malformed
 * falls back to the heuristics, so a missing or bad model degrades the plan's
 * wording rather than its validity.
 */
export async function proposeSlicesWithModel(
  adapter: LocalInferenceAdapter,
  spec: string,
  map: CodebaseMap | undefined,
): Promise<SliceProposal[] | undefined> {
  const fileList = (map?.files ?? []).slice(0, 40).join("\n");
  const request: InferenceRequest = {
    systemPrompt: SLICE_PROMPT,
    prompt: `Specification:\n${spec}\n\nFiles available:\n${fileList || "(no codebase map supplied)"}`,
    toolArm: adapter.supportedArms[0] ?? "arm_a_flat",
    temperature: 0.2,
  };

  let text: string;
  try {
    const response = await adapter.generate(request);
    text = response.text;
  } catch {
    return undefined;
  }

  const parsed = extractJsonObject(text);
  if (typeof parsed !== "object" || parsed === null || !("slices" in parsed)) {
    return undefined;
  }
  const raw = (parsed as { slices: unknown }).slices;
  if (!Array.isArray(raw)) {
    return undefined;
  }

  const proposals: SliceProposal[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const kind = typeof record.kind === "string" ? record.kind : "";
    const title = typeof record.title === "string" ? record.title.trim() : "";
    if (!SLICE_KINDS.has(kind) || title.length === 0) {
      continue;
    }
    const keywords = Array.isArray(record.keywords)
      ? record.keywords.filter((k): k is string => typeof k === "string")
      : contentWords(title);
    if (keywords.length === 0) {
      continue;
    }
    proposals.push({
      kind: kind as SpidrSliceKind,
      title,
      keywords,
      rationale:
        typeof record.rationale === "string" && record.rationale.trim().length > 0
          ? record.rationale.trim()
          : rationaleFor(kind as SpidrSliceKind, title),
      hazardCount: 0,
      ...(typeof record.behaviour === "string" && record.behaviour.trim()
        ? { behaviour: record.behaviour.trim() }
        : {}),
    });
  }

  if (proposals.length === 0) {
    return undefined;
  }
  return orderSlices(proposals);
}
