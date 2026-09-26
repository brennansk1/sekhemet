import { createHash } from "node:crypto";
import type { CardRecord, CardTier } from "@sekhemet/kernel";
import type { CardInterfaceSymbol, CardSplit } from "@sekhemet/kernel";
import {
  type InferenceRequest,
  type LocalInferenceAdapter,
  extractJsonObject,
  plannerCopy,
} from "@sekhemet/models";
import { KIND_OF_SLICE, capabilityVerdict } from "./capability_fit.js";
import { DEFAULT_MAX_SPLIT_DEPTH, DEFAULT_TIER_BUDGET, MAX_SCOPE_FILES } from "./constants.js";
import {
  type ExampleRow,
  exampleRows,
  invariantCriterion,
  sameWord,
  statedCriterion,
} from "./criteria.js";
import { splitStoriesAcrossRepos } from "./cross_repo.js";
import { routeByDifficulty, scoreDifficulty, stepBudgetForDifficulty } from "./difficulty.js";
import { validateInvest } from "./invest.js";
import { mechanismIn } from "./mechanisms.js";
import { acceptanceTestPath, selectScopeFiles } from "./scope.js";
import { zone3Fit } from "./small.js";
import {
  contentWords,
  matchPhrases,
  sentenceCase,
  splitSentences,
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
  MechanismEpic,
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
  /** Its acceptance criteria, each with its example rows when it has values. */
  criteria?: { text: string; examples?: ExampleRow[] }[];
  /** The symbols its test will import, as the model named them (PM-P1-15). */
  interface?: CardInterfaceSymbol[];
  /** Requirement ids the model said it proves (PM-P13-2). */
  requirementIds?: string[];
  /** The spec capability it was sliced from (PM-P13-2). */
  capability?: string;
  /** A hard invariant or the riskiest assumption: proven right after the contract. */
  early?: boolean;
}

interface Capability {
  text: string;
  keywords: string[];
  /** Example sentences the spec gives for it ("given …, … leaves 600"). */
  examples: string[];
}

function deterministicId(seed: string, slice: SpidrSliceKind, tier: CardTier): string {
  const digest = createHash("sha256").update(seed).digest("hex").slice(0, 8);
  return `${tier}_${slice}_${digest}`;
}

/** Separators of the capabilities one sentence enumerates. */
const SUB_CLAUSE = /,|\band\b|\bwith\b|\bplus\b|\bas well as\b|\balong with\b/i;

/** A sentence that gives an example rather than a capability: "given … 1000 …, … leaves 600". */
function isExample(text: string): boolean {
  return (/\bgiven\b/i.test(text) && /\d/.test(text)) || exampleRows(text).length > 0;
}

/**
 * Break a spec into the capabilities it actually enumerates.
 *
 * A sentence is split into sub-clauses only when every part is a phrase of
 * its own (two words or more): "log in with email and password" is one
 * capability, never "Email" and "Password" cards (PM-P1-9). A sentence that
 * gives an example is not a capability: it becomes a criterion of the one
 * before it (or of the first, when it comes first).
 */
export function deriveCapabilities(spec: string): Capability[] {
  const seen = new Set<string>();
  const capabilities: Capability[] = [];
  const pending: string[] = [];
  const attach = (example: string) => {
    const last = capabilities.at(-1);
    if (last) last.examples.push(example.trim());
    else pending.push(example.trim());
  };
  for (const sentence of splitSentences(spec)) {
    const colon = sentence.indexOf(":");
    const segments = colon > 0 ? [sentence.slice(0, colon), sentence.slice(colon + 1)] : [sentence];
    for (const segment of segments) {
      if (!segment.trim()) continue;
      if (isExample(segment)) {
        attach(segment);
        continue;
      }
      const parts = segment
        .split(SUB_CLAUSE)
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      const short = (p: string) => stripLeadVerb(p).split(/\s+/).length < 2;
      // A comma list enumerates features of its head ("profiles with
      // avatars, bio, and settings"): a one-word item keeps the head. Without
      // commas, a one-word part is an input of one action, not a capability.
      const head = parts[0] ?? "";
      const joiner = /\bwith\b/i.test(segment) ? " with " : " — ";
      const clauses = !parts.some(short)
        ? parts
        : segment.includes(",")
          ? parts.map((p, i) => (i > 0 && short(p) ? `${head}${joiner}${p}` : p))
          : [segment.trim()];
      for (const clause of clauses) {
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
        capabilities.push({ text, keywords, examples: [] });
      }
    }
  }
  if (pending.length > 0 && capabilities[0]) capabilities[0].examples.unshift(...pending);
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

/**
 * A card's title is the spec's own words for the capability (§2.1.2,
 * PM-P1-3): no "happy path" or "types and contracts first" appended — the
 * stored `kind` says what sort of card it is.
 */
function titleFor(kind: SpidrSliceKind, capability: string): string {
  return kind === "spike"
    ? `Spike: resolve ${capability}`
    : sentenceCase(capability.trim().replace(/[.;:]+$/, ""));
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
  const headline = capabilities[0]?.text ?? spec.trim();

  for (const spike of spikes) {
    proposals.push({
      kind: "spike",
      title: titleFor("spike", spike.topic),
      keywords: contentWords(spike.topic),
      rationale: rationaleFor("spike", spike.topic),
      hazardCount: 0,
      capability: headline,
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
      criteria: criteriaFor(kind, capability),
      capability: capability.text,
      ...(kind === "rule" && INVARIANT.test(capability.text) ? { early: true } : {}),
    });
  }

  const first = capabilities[0] ?? {
    text: headline,
    keywords: contentWords(headline),
    examples: [],
  };
  if (!proposals.some((p) => p.kind === "interface")) {
    proposals.unshift({
      kind: "interface",
      title: titleFor("interface", headline),
      keywords: contentWords(headline),
      rationale: rationaleFor("interface", headline),
      hazardCount: 0,
      criteria: criteriaFor("interface", first),
      capability: headline,
    });
  }
  if (!proposals.some((p) => p.kind === "path")) {
    proposals.push({
      kind: "path",
      title: titleFor("path", headline),
      keywords: contentWords(headline),
      rationale: rationaleFor("path", headline),
      hazardCount: 0,
      criteria: criteriaFor("path", first),
      capability: headline,
    });
  }

  /**
   * Each named failure mode becomes its own Path slice, after the happy
   * path, titled and stated in the words of the sentence that names it.
   */
  const sentences = splitSentences(spec);
  for (const hazard of matchPhrases(specTokens, HAZARD_SIGNALS)) {
    if (proposals.some((p) => p.keywords.includes(hazard.phrase))) {
      continue;
    }
    const sentence =
      sentences.find((x) => tokenize(x).some((t) => t.text === hazard.phrase)) ?? hazard.phrase;
    proposals.push({
      kind: "path",
      title: titleFor("path", stripLeadVerb(sentence)),
      keywords: [...contentWords(headline), hazard.phrase],
      rationale: rationaleFor("path", `${hazard.phrase} in ${headline}`),
      hazardCount: 1,
      criteria: [{ text: statedCriterion(stripLeadVerb(sentence)) }],
      capability: headline,
    });
  }

  return orderSlices(withRiskiest(proposals, options.riskiest));
}

/**
 * The heuristic's criteria, in the spec's own words (§2.1.2): the examples
 * the spec gives for the capability, each with its rows; else, for a hard
 * invariant, the correct behaviour (PM-P1-6); else the capability stated.
 * A stated capability has no value to assert, so the lint holds its card
 * in Planning until a person or the model gives an example — the heuristic
 * invents none. A contract card never takes the examples: they are the
 * behaviour cards'.
 */
function criteriaFor(
  kind: SpidrSliceKind,
  capability: Capability,
): { text: string; examples?: ExampleRow[] }[] {
  if (kind !== "interface" && capability.examples.length > 0) {
    return capability.examples.map((e) => {
      const rows = exampleRows(e);
      return { text: statedCriterion(e), ...(rows.length > 0 ? { examples: rows } : {}) };
    });
  }
  const invariant = kind === "rule" ? invariantCriterion(capability.text) : undefined;
  return [{ text: invariant ?? statedCriterion(capability.text) }];
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
      criteria: [{ text: invariantCriterion(claim) ?? statedCriterion(claim) }],
      // The riskiest assumption is the whole brief's risk: it traces to the headline.
      ...(proposals[0]?.capability ? { capability: proposals[0].capability } : {}),
      early: true,
    },
  ];
}

/**
 * A slice's acceptance tests: one per criterion, in the slice's test file.
 * The tautology "<title> is observable through the exported surface of
 * <file>", which an empty export satisfies, is never written (§2.3.2 e).
 */
function acceptanceFor(proposal: SliceProposal, testPath: string): AcceptanceTestSpec[] {
  const criteria =
    proposal.criteria && proposal.criteria.length > 0
      ? proposal.criteria
      : [{ text: proposal.behaviour ?? statedCriterion(proposal.title) }];
  return criteria.map((c) => ({
    filePath: testPath,
    assertion: c.text,
    initiallyFailing: true,
    ...(c.examples && c.examples.length > 0 ? { examples: c.examples } : {}),
  }));
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
  /** The SPIDR axis a split child was split along. */
  split?: CardSplit;
  /** Extra id entropy so a split child never collides with another branch. */
  idSeed?: string;
}

/** The Zone 3 content of a story before its test is written (`small.ts`). */
function storyZone3(
  story: Pick<PlannedStory, "card" | "rationale" | "acceptanceTests" | "interface">,
  map: CodebaseMap | undefined,
): number {
  return zone3Fit(
    {
      id: story.card.id,
      title: story.card.title,
      spec: story.card.spec ?? `${story.card.title}\n\n${story.rationale}`,
      acceptanceCriteria: story.acceptanceTests.map((t) => t.assertion),
      scopeFiles: story.card.scopeFiles,
      ...(story.interface ? { interface: story.interface } : {}),
    },
    { promptBudgetTokens: 0, codebaseMap: map },
  ).tokens;
}

const isTestPath = (f: string) => /\.(spec|test)\.[cm]?[jt]sx?$/.test(f);

function buildStory(params: BuildStoryParams): PlannedStory {
  const { proposal, map, budget, taken } = params;
  // K-N9-4: the SPIDR split axis is stored for display and export only;
  // read here (once, to hand it to storage) via destructuring rather than
  // a direct property read of `split`, which the frozen source scan
  // (card_fields K-N9-4) would otherwise flag as a decision-making read.
  const { split: splitAxis } = params;
  const maxFiles = Math.min(budget.maxFiles, MAX_SCOPE_FILES);
  // The files the model named for the test's imports are in scope first.
  const named = [
    ...new Set((proposal.interface ?? []).map((s) => s.file).filter((f) => !isTestPath(f))),
  ].slice(0, maxFiles);
  const picked = selectScopeFiles(
    proposal.kind,
    proposal.keywords,
    map,
    new Set([...taken, ...named]),
    maxFiles - named.length,
  );
  const selection =
    named.length === 0
      ? picked
      : {
          ...picked,
          files: [...named, ...(picked.existing.length > 0 ? picked.existing : [])].slice(
            0,
            maxFiles,
          ),
        };
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
  const acceptanceTests = acceptanceFor(proposal, testPath);

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
    estimatedPackTokens: storyZone3(
      {
        card,
        rationale: proposal.rationale,
        acceptanceTests,
        ...(proposal.interface ? { interface: proposal.interface } : {}),
      },
      map,
    ),
    ...(params.splitFrom !== undefined ? { splitFrom: params.splitFrom } : {}),
    splitDepth: params.splitDepth,
    ...(splitAxis ? { split: splitAxis } : {}),
    ...(proposal.capability ? { capability: proposal.capability } : {}),
    ...(proposal.interface && proposal.interface.length > 0
      ? { interface: proposal.interface }
      : {}),
    ...(proposal.requirementIds && proposal.requirementIds.length > 0
      ? { requirementIds: proposal.requirementIds }
      : {}),
    ...(routing === "edit_sketch"
      ? { editSketch: editSketchFor(id, proposal, selection.files, selection.symbols) }
      : {}),
  };
}

/**
 * The SPIDR axis a story of each slice is split along (DEC-26): a flow is
 * split by path, storage by data variety, a rule by rules; a contract card
 * split into smaller type groups restricts data variety. `interface` — the
 * *user* interface — is never a contract's split.
 */
const SPLIT_AXIS: Record<SpidrSliceKind, CardSplit> = {
  spike: "spike",
  interface: "data",
  data: "data",
  path: "path",
  rule: "rules",
};

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
    const first = story.keywords.slice(0, midpoint);
    const second = story.keywords.slice(midpoint);
    axes.push({ keywords: first, label: first.join(" ") });
    axes.push({ keywords: second, label: second.join(" ") });
  } else if (story.acceptanceTests.length > 1) {
    for (const test of story.acceptanceTests) {
      const words = contentWords(test.assertion).slice(0, 3);
      axes.push({ keywords: words, label: words.join(" ") });
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

  // PM-P1-7: each criterion goes to the one part whose axis it is about, so
  // each part keeps its own behaviour and only the tests that exercise it.
  const own = usable.map((): AcceptanceTestSpec[] => []);
  for (const test of story.acceptanceTests) {
    const words = contentWords(test.assertion);
    const scores = usable.map(
      (axis) =>
        axis.keywords.filter((k) => words.some((w) => sameWord(w, k))).length /
        axis.keywords.length,
    );
    const best = scores.indexOf(Math.max(...scores));
    own[best]?.push(test);
  }

  const children: PlannedStory[] = [];
  for (const [index, axis] of usable.entries()) {
    const previous = children[index - 1];
    const mine = own[index] ?? [];
    const child = buildStory({
      proposal: {
        kind: story.slice,
        title: `${story.card.title} — ${axis.label}`,
        keywords: axis.keywords,
        rationale: `${story.rationale} Split from ${story.card.id}: the parent exceeded its tier budget.`,
        hazardCount: 0,
        criteria:
          mine.length > 0
            ? mine.map((t) => ({
                text: t.assertion,
                ...(t.examples ? { examples: t.examples } : {}),
              }))
            : [{ text: statedCriterion(`${story.card.title} ${axis.label}`) }],
        ...(story.capability ? { capability: story.capability } : {}),
        ...(story.requirementIds ? { requirementIds: story.requirementIds } : {}),
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
      split: SPLIT_AXIS[story.slice],
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
  /** Mechanisms refused as single cards and re-split as epics (PM-P1-20). */
  epics: MechanismEpic[];
  /** Why each refused model reply was refused (PM-P1-4). */
  modelRefusals: string[];
}

/**
 * PM-P1-20: a proposal that names a mechanism of §2.1.10 is not a card. It
 * is taken out of the plan and becomes an epic of its own, planned apart.
 */
function withoutMechanisms(proposals: SliceProposal[]): {
  kept: SliceProposal[];
  epics: MechanismEpic[];
} {
  const epics: MechanismEpic[] = [];
  const kept = proposals.filter((p) => {
    const mechanism = mechanismIn(`${p.title} ${p.capability ?? ""}`);
    if (!mechanism) return true;
    if (!epics.some((e) => e.mechanism === mechanism)) {
      const capability = p.capability ?? p.title;
      epics.push({ mechanism, title: titleFor("path", capability), capability });
    }
    return false;
  });
  return { kept, epics };
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

  // Model first (§2.1.2, PM-P1-4): a refused reply is retried once, then
  // the heuristic plans in the spec's own words.
  const asked =
    params.adapter === undefined
      ? { refusals: [] as string[] }
      : await requestSlicesWithModel(params.adapter, params.spec, params.codebaseMap);
  const modelProposals = asked.proposals;
  const { kept: proposals, epics } = withoutMechanisms(
    modelProposals
      ? orderSlices(withRiskiest(modelProposals, params.riskiest))
      : proposeSlices(
          params.spec,
          params.spikes,
          params.riskiest ? { riskiest: params.riskiest } : {},
        ),
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
    // PM-N3-2: a story the Worker's measured record says it will likely fail
    // (predicted pass under 0.6, or over the kind's 80% horizon) is split
    // before it is scheduled; a kind under 10 attempts is never split here.
    const capability = params.capability;
    if (capability) {
      for (const story of stories) {
        const verdict = capabilityVerdict(capability, {
          kind: KIND_OF_SLICE[story.slice],
          difficulty: story.difficulty.value,
        });
        if (verdict.shouldSplit) pending.add(story.card.id);
      }
    }
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
      // PM-P1-13: a lineage at the depth limit is never split again; it
      // stays over the bounds, and persist holds it in Planning.
      const children =
        story.splitDepth >= maxDepth
          ? undefined
          : splitStory(story, params.codebaseMap, budget, taken, advances, now);
      if (children === undefined) {
        ceilinged.add(story.card.id);
        capabilityCeilings.push({
          storyId: story.card.id,
          reason: `"${story.card.title}" still exceeds the tier budget (difficulty ${story.difficulty.value}, ${story.estimatedPackTokens} Zone 3 tokens, ${story.card.stepBudget} steps) and has no remaining axis to split on.`,
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

  // RG-N3-2: a story spanning repositories is one card per repository.
  const repos = params.codebaseMap?.repos;
  if (repos && repos.length > 1) stories = splitStoriesAcrossRepos(stories, repos);

  return { stories, capabilityCeilings, source, epics, modelRefusals: asked.refusals };
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

/** The one JSON reader (models `extractJsonObject`, MD-N4-8). */
export { extractJsonObject } from "@sekhemet/models";

// CX-M1-13: these sentences live in the planner's copy module
// (`@sekhemet/models` `plannerCopy.sliceLines`), never here.
const SLICE_PROMPT = plannerCopy.sliceLines.join(" ");

type SliceReply = { proposals: SliceProposal[] } | { refused: string };

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : [];
}

function examplesOf(v: unknown): ExampleRow[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((e) => {
    const r = e as { args?: unknown; expected?: unknown } | null;
    return r && Array.isArray(r.args) && "expected" in r
      ? [{ args: r.args as unknown[], expected: r.expected }]
      : [];
  });
}

/** A safe JS identifier: what a generated `import { X } from ...` may name. */
const VALID_SYMBOL = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** A safe repo-relative path: no absolute path, no drive letter, no quote or escape character. */
const VALID_REPO_FILE = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/;

/**
 * The model's `file` as a safe repo-relative path, or undefined when it
 * names something else (BLOCKER: a model-controlled string is pasted into
 * generated test source and then run — spidr.ts, staging.ts,
 * approvals.ts): no absolute path, no `..` segment, no character that could
 * break out of a generated string literal.
 */
function safeRepoRelativeFile(file: string): string | undefined {
  const f = file.replace(/^\.\//, "").trim();
  if (!VALID_REPO_FILE.test(f)) return undefined;
  if (f.split("/").some((seg) => seg === "..")) return undefined;
  return f;
}

function interfaceOf(v: unknown): CardInterfaceSymbol[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((e) => {
    const r = e as Partial<CardInterfaceSymbol> | null;
    if (!r || typeof r.symbol !== "string" || typeof r.file !== "string") return [];
    if (!VALID_SYMBOL.test(r.symbol)) return [];
    const file = safeRepoRelativeFile(r.file);
    if (file === undefined) return [];
    return [
      {
        symbol: r.symbol,
        file,
        signature: typeof r.signature === "string" ? r.signature : "",
      },
    ];
  });
}

/**
 * Read one model reply into slice proposals, or say why it is refused
 * (PM-P1-4): truncated output, malformed JSON, no slice list, an empty
 * list, or a slice of an unknown kind or with no title refuses the whole
 * reply — a half-understood plan is not planned from.
 */
export function parseSliceReply(text: string, finishReason?: string): SliceReply {
  if (finishReason === "length") return { refused: "truncated output (the answer hit its cap)" };
  const parsed = extractJsonObject(text);
  if (typeof parsed !== "object" || parsed === null || !("slices" in parsed)) {
    return { refused: "malformed JSON: no slices object" };
  }
  const raw = (parsed as { slices: unknown }).slices;
  if (!Array.isArray(raw)) return { refused: "malformed JSON: slices is not a list" };
  if (raw.length === 0) return { refused: "an empty slice list" };
  const proposals: SliceProposal[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return { refused: "a slice is not an object" };
    const record = entry as Record<string, unknown>;
    const kind = typeof record.kind === "string" ? record.kind : "";
    const title = typeof record.title === "string" ? record.title.trim() : "";
    if (!SLICE_KINDS.has(kind)) return { refused: `an unknown slice kind "${kind}"` };
    if (title.length === 0) return { refused: "a slice with no title" };
    const keywords = stringList(record.keywords);
    const criteria = Array.isArray(record.criteria)
      ? record.criteria.flatMap((c) => {
          const r = (typeof c === "string" ? { text: c } : c) as {
            text?: unknown;
            examples?: unknown;
          } | null;
          if (!r || typeof r.text !== "string" || !r.text.trim()) return [];
          const examples = examplesOf(r.examples);
          return [{ text: r.text.trim(), ...(examples.length > 0 ? { examples } : {}) }];
        })
      : [];
    const behaviour =
      typeof record.behaviour === "string" && record.behaviour.trim()
        ? record.behaviour.trim()
        : undefined;
    const iface = interfaceOf(record.interface);
    const requirementIds = stringList(record.requirementIds);
    proposals.push({
      kind: kind as SpidrSliceKind,
      title,
      keywords: keywords.length > 0 ? keywords : contentWords(title),
      rationale:
        typeof record.rationale === "string" && record.rationale.trim().length > 0
          ? record.rationale.trim()
          : rationaleFor(kind as SpidrSliceKind, title),
      hazardCount: 0,
      ...(behaviour ? { behaviour } : {}),
      ...(criteria.length > 0
        ? { criteria }
        : behaviour
          ? { criteria: [{ text: behaviour }] }
          : {}),
      ...(iface.length > 0 ? { interface: iface } : {}),
      ...(requirementIds.length > 0 ? { requirementIds } : {}),
    });
  }
  return { proposals: orderSlices(proposals) };
}

function sliceRequest(
  adapter: LocalInferenceAdapter,
  spec: string,
  map: CodebaseMap | undefined,
): InferenceRequest {
  const fileList = (map?.files ?? []).slice(0, 40).join("\n");
  return {
    systemPrompt: SLICE_PROMPT,
    prompt: `Specification:\n${spec}\n\nFiles available:\n${fileList || "(no codebase map supplied)"}`,
    toolArm: adapter.supportedArms[0] ?? "arm_a_flat",
    // §2.1.3: temperature 0, so one spec gives one plan.
    temperature: 0,
  };
}

/**
 * Ask the Planner's model for slices, and treat its answer as a proposal
 * (§2.1.2-3, PM-P1-4): a refused reply is asked once more; a second refusal,
 * or a model that cannot answer at all, leaves the plan to the heuristic.
 * Whatever is accepted is still re-costed, run through INVEST and split
 * like any heuristic slice.
 */
export async function requestSlicesWithModel(
  adapter: LocalInferenceAdapter,
  spec: string,
  map: CodebaseMap | undefined,
): Promise<{ proposals?: SliceProposal[]; refusals: string[] }> {
  const refusals: string[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let text: string;
    let finish: string | undefined;
    try {
      const response = await adapter.generate(sliceRequest(adapter, spec, map));
      text = response.text;
      finish = response.finishReason;
    } catch (err) {
      // A model that cannot be loaded or answer: the heuristic, now.
      refusals.push(`no answer: ${err instanceof Error ? err.message : String(err)}`);
      return { refusals };
    }
    const reply = parseSliceReply(text, finish);
    if ("proposals" in reply) return { proposals: reply.proposals, refusals };
    refusals.push(reply.refused);
  }
  return { refusals };
}

/** One request, no retry: the proposals, or undefined when the reply is refused. */
export async function proposeSlicesWithModel(
  adapter: LocalInferenceAdapter,
  spec: string,
  map: CodebaseMap | undefined,
): Promise<SliceProposal[] | undefined> {
  try {
    const response = await adapter.generate(sliceRequest(adapter, spec, map));
    const reply = parseSliceReply(response.text, response.finishReason);
    return "proposals" in reply ? reply.proposals : undefined;
  } catch {
    return undefined;
  }
}
