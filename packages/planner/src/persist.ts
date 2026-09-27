import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  CardChange,
  CardInterfaceSymbol,
  CardRecord,
  CardStatus,
  CreateCardInput,
} from "@sekhemet/kernel";
import type { LocalInferenceAdapter } from "@sekhemet/models";
import { approvalHold } from "./approval_hold.js";
import {
  type DepthProfile,
  hasDependency,
  needsPropertyTest,
  propertySeed,
  renderPropertyTest,
} from "./approvals.js";
import {
  changeOf,
  renderSupersedingTest,
  repoHasHistory,
  supersededTests,
  testsReaching,
  untestedScopeFiles,
} from "./brownfield.js";
import { ASSUMPTION_EVENTS } from "./calibration_store.js";
import {
  type CapabilityModel,
  KIND_OF_SLICE,
  capabilityVerdict,
  recordCapabilityFit,
} from "./capability_fit.js";
import { DEFAULT_TIER_BUDGET, INVEST_MAX_STEPS } from "./constants.js";
import { criterionIdsFor, exampleRows, lintCriterion } from "./criteria.js";
import { buildDecisionRequest } from "./decision.js";
import { DecisionStore, waitingReason } from "./decisions.js";
import { type PlannerTools, sketchWithModel } from "./edit_sketch.js";
import { type CardEstimate, EstimationModel } from "./estimation.js";
import { analyzeImpact } from "./impact.js";
import { validateInvest } from "./invest.js";
import { type PlannerLedger, appendPlannerEvent } from "./ledger.js";
import { localiseFix } from "./localise.js";
import { type OracleDispute, crossCheckRows, recordExamples } from "./oracle.js";
import { PLANNED_WITHOUT_MODEL } from "./planner.js";
import { SPLIT_POINTS, estimatePoints } from "./points.js";
import { workerPromptBudget, zone3Cap, zone3Fit } from "./small.js";
import { safeRepoRelativeFile } from "./spidr.js";
import {
  type StagedCriterion,
  type TestFramework,
  detectTestFramework,
  interfaceFromTest,
  renderExampleTest,
  signatureFromRows,
} from "./staging.js";
import { resolveTraces } from "./traces.js";
import type {
  DecisionRequest,
  EditSketch,
  InvestValidationReport,
  PlannedStory,
  RoutingDecision,
  SpidrPlan,
  TierBudget,
} from "./types.js";

/**
 * Persist a plan as cards with their whole contract (planner-pm §2.1.5),
 * with INVEST enforced rather than advisory:
 *
 * - every story becomes a card carrying its spec, acceptance criteria with
 *   stable ids, difficulty, routing, points, budgets, its stored `kind`,
 *   `change`, and — for a split child — `split` and `splitDepth` (DEC-26),
 *   the interface its staged test imports, and the requirement ids and
 *   versions it traces to (PM-P13-2);
 * - a criterion with concrete values is staged as an example table in the
 *   project's own test framework, each case naming its criterion
 *   (PM-P1-17, PM-P1-19); a card is held in Planning, with the reason, while
 *   a criterion is refused by the lint, a criterion has no staged case,
 *   INVEST's *Small* (Zone 3's fit, `small.ts`) fails, or it is at the split
 *   depth limit (PM-P1-5, PM-P1-18, PM-12, PM-P1-13);
 * - INVEST `reject` stories and stories that trace to no requirement are not
 *   created (the latter offered as proposed changes); overlap with cards
 *   already in progress is serialized as a dependency (Independent);
 * - the edit sketch and the logged assumptions go to the card's dossier,
 *   which the card runner puts in front of the Worker;
 * - a mechanism refused as a single card is created as an epic of its own
 *   (PM-P1-20); an estimate of 8 is proposed for a split (PM-N1-2);
 * - the plan itself is a versioned `plan/created` event, so a replan can be
 *   diffed against it.
 */
export interface PersistPlanOptions {
  epicId: string;
  /**
   * The planning model. With it, cards routed `edit_sketch` (difficulty
   * 4-7) get a model-written, scope-checked sketch (PM-P1-16); without it,
   * the template sketch.
   */
  sketcher?: LocalInferenceAdapter;
  /** An approved MCP server's tools, offered to the sketcher within the prompt budget (EXT-20). */
  plannerTools?: PlannerTools;
  /**
   * Repository root: grounds sketches in real outlines, adds impact, is where
   * staged tests are written, and is what Zone 3 is measured from.
   */
  repoRoot?: string;
  estimator?: EstimationModel;
  /** The resolved Worker's window (`workerWindowTokens`), from the registry. */
  tierBudget?: TierBudget;
  actor?: string;
  /** Who asked for the plan: requirements derived from the spec are theirs (PM-P13-2). */
  principal?: string;
  /**
   * Derive requirements from the spec for capabilities no requirement
   * covers (default). `false` when a brief's accepted requirements are the
   * only ones: a card covering none of them is refused (`traces.ts`).
   */
  deriveRequirements?: boolean;
  /** What the cards do to existing code; a new project's are all `feature` (PM-P1-12). */
  change?: CardChange;
  /**
   * The Worker's measured record (PM-N3-1/2): its fitted horizons are
   * recorded, and a card the planner could not split under it is held.
   */
  capability?: CapabilityModel;
  /**
   * The depth profile (PM-N7-1…3); the one recorded for the project
   * (DS-P14-3, `depthProfiles.of`) when absent.
   */
  depthProfile?: DepthProfile;
  /** The independent second sampler of example rows (PM-N7-2); the sketcher when absent. */
  oracle?: LocalInferenceAdapter;
  /** A repository with history (PM-N6); read from `repoRoot` when absent. */
  hasHistory?: boolean;
  /**
   * Rank a `fix` card's candidate lines from its reproduction's coverage
   * (PM-N6-5). On by default when the project's test runner is installed.
   */
  localise?: boolean;
}

export interface PersistedStory {
  id: string;
  title: string;
  status: CardStatus;
  difficulty: number;
  routing: RoutingDecision;
  estimate: CardEstimate;
  /** Points (1, 2, 3, 5, 8), written to the card's `estimate` (PM-N1-1). */
  points: number;
  /** Its Zone 3 content as measured at persist: INVEST *Small*'s number (PM-14). */
  zone3Tokens: number;
  /** The spec capability it was built for (`resolveTraces`), whatever its title says (DS-P7-8). */
  capability?: string;
}

export interface PersistPlanResult {
  source: SpidrPlan["source"];
  created: PersistedStory[];
  rejected: { id: string; title: string; reason: string }[];
  /** Cards created in Planning, each with why it cannot be Ready yet. */
  held: { id: string; reasons: string[] }[];
  serialized: { id: string; after: string; files: string[] }[];
  sketches: { id: string; source: "model" | "template"; rejected?: string }[];
  /** Ideas that trace to no requirement: for a person to accept, never cards (§2.15.2). */
  proposedChanges: { id: string; title: string; reason: string }[];
  /** Cards estimated at 8 points, proposed for a split in this plan (PM-N1-2). */
  proposedSplits: { id: string; title: string; points: number }[];
  /** Mechanisms re-split as epics of their own (PM-P1-20). */
  epics: { id: string; mechanism: string; title: string }[];
  /** Why each refused model reply was refused (PM-P1-4). */
  modelRefusals: string[];
  /** Development dependencies the staged tests need, for a person to apply (PM-N7-1). */
  proposedDependencies: { name: string; dev: boolean; reason: string }[];
  /** Characterize cards planned before a change to untested code (PM-N6-2). */
  characterized: { id: string; before: string; files: string[] }[];
  /** Base tests each card supersedes, their new versions staged (PM-N6-3). */
  superseded: { id: string; tests: string[] }[];
  /** Example rows whose two samples disagreed, each a decision (PM-N7-2). */
  disputes: { id: string; decisionId: string }[];
  decisionId?: string;
  /**
   * Every question the pass posted (at most two, PM-P2-3), and whether it
   * holds the new cards: only a default_deny one does (PM-P2-4).
   */
  decisions?: { id: string; policy: DecisionRequest["policy"]; holds: boolean }[];
  invest: InvestValidationReport;
  version: number;
}

/** The symbol a heuristic card's test calls: its capability's words, as an identifier. */
function heuristicSymbol(story: PlannedStory): string {
  const words = story.keywords.filter((w) => /^[a-z][a-z0-9]*$/.test(w));
  const picked = words.length > 1 ? [words[0], words.at(-1)] : words.slice(0, 1);
  const name = (picked as string[])
    .map((w, i) => (i === 0 ? w : `${w.charAt(0).toUpperCase()}${w.slice(1)}`))
    .join("");
  return name || "feature";
}

/** A test path that does not overwrite a different file already there. */
function freeTestPath(root: string | undefined, path: string, source: string): string {
  if (!root) return path;
  let candidate = path;
  let n = 2;
  while (
    existsSync(join(root, candidate)) &&
    readFileSync(join(root, candidate), "utf8") !== source
  ) {
    candidate = path.replace(/(\.(?:spec|test))?(\.[cm]?[jt]sx?)$/, `_${n}$1$2`);
    n += 1;
  }
  return candidate;
}

const ACTIVE: CardStatus[] = ["in_progress", "verify", "review"];

type RenderedFile = { source: string; cases: { name: string; criterionId: string }[] };

/** The folder part of a test path, with its trailing slash. */
function posixDir(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? "" : path.slice(0, at + 1);
}

/** `tests/x.spec.ts` → `tests/x.<kind>.spec.ts`: a staged file beside the card's table. */
function siblingPath(testPath: string, kind: string): string {
  const m = /^(.*?)((?:\.(?:spec|test))?\.[cm]?[jt]sx?)$/.exec(testPath);
  return m ? `${m[1]}.${kind}${m[2]}` : `${testPath}.${kind}`;
}

/** Write a staged file into the repository unless one is there already. */
function writeStaged(root: string | undefined, path: string, source: string): void {
  if (!root) return;
  const abs = join(root, path);
  mkdirSync(dirname(abs), { recursive: true });
  if (!existsSync(abs)) writeFileSync(abs, source);
}

/**
 * How to run one test file with the project's own runner, when it is
 * installed: localisation never fetches a runner from the network.
 */
function testCommand(
  root: string,
  framework: TestFramework,
): ((file: string) => string[]) | undefined {
  if (framework === "node") return (file) => ["node", "--test", file];
  const bin = join(root, "node_modules", ".bin", framework === "jest" ? "jest" : "vitest");
  if (!existsSync(bin)) return undefined;
  return framework === "jest"
    ? (file) => [bin, "--coverage=false", file]
    : (file) => [bin, "run", "--pool=forks", file];
}

/** `executor` model role for a route (the queue maps roles to models). */
export function modelRouteFor(routing: RoutingDecision): { planner?: string; executor: string } {
  switch (routing) {
    case "direct":
      return { executor: "worker" };
    case "edit_sketch":
      return { planner: "manager", executor: "worker" };
    default:
      return { planner: "manager", executor: "escalation" };
  }
}

export function formatEditSketch(s: EditSketch): string {
  return [
    "Edit sketch from the planner (follow it unless the code says otherwise):",
    ...s.targetSymbols.map((t) => `- ${t.change} ${t.symbol} in ${t.filePath}`),
    `Preconditions: ${s.preconditions.join(" ")}`,
    `Invariants: ${s.invariants.join(" ")}`,
    `Approach: ${s.diffSketch}`,
    `Blast radius: ${s.blastRadius.join(", ") || "scope files only"}`,
  ].join("\n");
}

function clampDifficulty(v: number): number {
  return Math.min(10, Math.max(1, Math.round(v)));
}

export async function persistPlan(
  ledger: PlannerLedger,
  plan: SpidrPlan,
  options: PersistPlanOptions,
): Promise<PersistPlanResult> {
  const { store } = ledger;
  const actor = options.actor ?? "planner";
  const all = await store.listCards();
  const estimator = options.estimator ?? EstimationModel.fromCards(all);
  const active = all.filter((c) => ACTIVE.includes(c.status));
  const budget = options.tierBudget ?? DEFAULT_TIER_BUDGET;
  // INVEST's Small: Zone 3's cap at the resolved Worker's W (PM-12, PM-13).
  const promptBudget = workerPromptBudget(budget.workerWindowTokens);
  const cap = zone3Cap(promptBudget);

  // INVEST with the live board: overlap with running cards is serialized.
  const invest = validateInvest(plan.stories, {
    tierBudget: budget,
    activeCardScopes: active.map((c) => ({ cardId: c.id, filesTouched: c.scopeFiles })),
  });
  const rejectedIds = new Set(invest.rejected);
  const ceilings = new Map(plan.capabilityCeilings.map((c) => [c.storyId, c]));
  const reasonFor = (id: string): string =>
    invest.checks
      .filter((c) => c.offendingStoryIds.includes(id) && c.action === "reject")
      .map((c) => c.detail)
      .join(" ") || "rejected by the INVEST pre-flight";
  // Small is judged below on the card as stored (one computation, PM-14);
  // the other re-split checks as the pre-flight found them.
  const investHolds = (id: string): string[] =>
    invest.checks
      .filter(
        (c) => c.offendingStoryIds.includes(id) && c.action === "resplit" && c.check !== "small",
      )
      .map((c) => `INVEST ${c.check}: ${c.detail}`);

  const epic = await store.getCard(options.epicId);
  const projectId = epic?.projectId;
  const principal = options.principal ?? store.localPrincipal();
  const heuristic = plan.source === "heuristic";

  const ask = plan.ambiguity.askUser && plan.ambiguity.decision !== undefined;
  // Every question of the pass's batch (at most two, PM-P2-3) is posted
  // first, so the stories can name the one they wait on. Only a default_deny
  // question holds them (PM-P2-4): a safe_default one is asked while
  // planning proceeds on its default.
  const posted: { id: string; policy: DecisionRequest["policy"] }[] = [];
  if (ask && plan.ambiguity.decision) {
    const decisions = new DecisionStore(ledger);
    const first = plan.ambiguity.decision;
    const batch = plan.ambiguity.batch?.requests ?? [];
    // The first question leads; the batch's others follow it.
    for (const request of [first, ...batch.filter((r) => r.id !== first.id)]) {
      posted.push({
        id: await decisions.request({ ...request, cardId: options.epicId }),
        policy: request.policy,
      });
    }
  }
  const holdingId = posted.find((d) => d.policy === "default_deny")?.id;
  const decisionId = holdingId ?? posted[0]?.id;
  const result: PersistPlanResult = {
    source: plan.source,
    created: [],
    rejected: [],
    held: [],
    serialized: [],
    sketches: [],
    proposedChanges: [],
    proposedSplits: [],
    epics: [],
    modelRefusals: plan.modelRefusals ?? [],
    proposedDependencies: [],
    characterized: [],
    superseded: [],
    disputes: [],
    invest,
    version: 1,
    ...(decisionId ? { decisionId } : {}),
    ...(posted.length
      ? { decisions: posted.map((d) => ({ ...d, holds: d.id === holdingId })) }
      : {}),
  };
  const createdIds = new Set<string>();
  const known = new Set(all.map((c) => c.id));
  const profile = options.depthProfile ?? store.depthProfiles.of(projectId).profile;
  const hasHistory = options.hasHistory ?? repoHasHistory(options.repoRoot);
  const oracle = options.oracle ?? options.sketcher;
  // PM-N3-1: the fitted horizons are recorded once per change in the record.
  if (options.capability) await recordCapabilityFit(ledger, options.capability);
  const mustHave = async (requirementIds: readonly string[]): Promise<boolean> => {
    for (const r of requirementIds) {
      if ((await store.requirements.get(r))?.mustHave) return true;
    }
    return false;
  };
  const proposeDependency = (name: string, reason: string) => {
    if (result.proposedDependencies.some((d) => d.name === name)) return;
    result.proposedDependencies.push({ name, dev: true, reason });
  };

  // PM-P1-20: a mechanism refused as a single card is an epic of its own,
  // planned apart; it waits in Backlog, never as a runnable card.
  for (const e of plan.epics ?? []) {
    const id = `epic_${createHash("sha256").update(`${options.epicId}:${e.mechanism}`).digest("hex").slice(0, 8)}`;
    if (known.has(id) || createdIds.has(id)) continue;
    await store.createCard(
      {
        id,
        tier: "epic",
        title: e.title,
        status: "backlog",
        spec: `${e.capability}\n\nA ${e.mechanism} is an epic of many cards, not one card (planner-pm §2.1.10): plan it on its own.`,
        labels: ["mechanism"],
        ...(projectId ? { projectId } : {}),
      },
      actor,
    );
    createdIds.add(id);
    result.epics.push({ id, mechanism: e.mechanism, title: e.title });
  }

  // PM-P13-2: what each story traces to, deriving requirements from the
  // spec where no brief's requirement covers a capability.
  const traces = await resolveTraces(store, {
    stories: plan.stories.filter((s) => !rejectedIds.has(s.card.id)),
    spec: plan.spec,
    projectId,
    derive: options.deriveRequirements ?? true,
    principal,
  });
  const framework = detectTestFramework(options.repoRoot);
  const history = all
    .filter(
      (c) =>
        c.status === "done" &&
        c.estimate !== undefined &&
        c.difficulty !== undefined &&
        (projectId === undefined || c.projectId === projectId),
    )
    .map((c) => ({ difficulty: c.difficulty as number, estimate: c.estimate as number }));

  for (const story of plan.stories) {
    const id = story.card.id;
    // K-N9-4: read once via destructuring, to hand it to storage — never a
    // direct property read of `split`, which nothing outside storage,
    // display and export may make (the stored `kind` decides everything else).
    const { split: storySplitAxis } = story;
    if (rejectedIds.has(id)) {
      result.rejected.push({ id, title: story.card.title, reason: reasonFor(id) });
      continue;
    }
    const requirementIds = traces.byStory.get(id) ?? [];
    if (requirementIds.length === 0) {
      const reason =
        "traces to no accepted requirement: accept it as a requirement to plan it (planner-pm §2.15.2)";
      result.rejected.push({ id, title: story.card.title, reason });
      result.proposedChanges.push({ id, title: story.card.title, reason });
      continue;
    }
    const deps = story.dependsOn.filter((d) => createdIds.has(d) || known.has(d));
    for (const a of active) {
      const shared = story.card.scopeFiles.filter((f) => a.scopeFiles.includes(f));
      if (shared.length > 0 && !deps.includes(a.id)) {
        deps.push(a.id);
        result.serialized.push({ id, after: a.id, files: shared });
      }
    }

    // PM-N6-1: one `change`, apart from the kind; chosen from what the card
    // is asked to do in a repository with history, `feature` in a new one.
    const change: CardChange =
      story.change ??
      options.change ??
      changeOf(`${plan.spec ?? ""} ${story.card.title}`, hasHistory);
    // A refactor or an upgrade adds no behaviour tests; its criteria are
    // proven by the tests the base already has (§2.16.1).
    const stagesTests = change === "feature" || change === "fix" || change === "characterize";
    const needsCases = change === "feature" || change === "fix";

    // PM-N6-2: code no base test executes is pinned by a characterize card first.
    const untested =
      hasHistory && options.repoRoot && needsCases
        ? untestedScopeFiles(options.repoRoot, story.card.scopeFiles)
        : [];
    if (untested.length > 0) {
      const charId = `${id}_char`;
      if (!known.has(charId) && !createdIds.has(charId)) {
        const charCriteria = [
          `Tests pin what ${untested.join(", ")} ${untested.length === 1 ? "does" : "do"} today, and they pass on the base`,
        ];
        // Budgets as its feature's: characterizing the files costs no more than changing them.
        const charEstimate = estimate(estimator, story);
        const charTest = `${posixDir(story.acceptanceTests[0]?.filePath ?? `tests/${id}.spec.ts`)}${id}.characterization.spec.ts`;
        await store.createCard(
          {
            id: charId,
            tier: story.card.tier,
            parentId: options.epicId,
            title: `Characterize ${untested.join(", ")} before "${story.card.title}"`,
            status: "planning",
            scopeFiles: [...untested, charTest],
            stepBudget: story.card.stepBudget,
            spec: `Pin today's behaviour of ${untested.join(", ")} with tests whose expected values are recorded by running the code on the base (a characterize card: its tests pass on the base, planner-pm §2.16.2). "${story.card.title}" changes this code next.`,
            acceptanceCriteria: charCriteria,
            criterionIds: criterionIdsFor(charId, charCriteria.length),
            difficulty: 2,
            estimate: estimatePoints(2, history).points,
            tokenBudget: charEstimate.tokens,
            secondsBudget: charEstimate.seconds,
            kind: "implement",
            change: "characterize",
            split: null,
            modelRoute: modelRouteFor("direct"),
            labels: ["characterize", ...(heuristic ? ["no-model"] : [])],
            blockedReason: approvalHold(charId),
            ...(projectId ? { projectId } : {}),
          },
          actor,
        );
        for (const requirementId of requirementIds) {
          await store.requirements.link({ requirementId, from: "card", ref: charId }, actor);
        }
        createdIds.add(charId);
        result.created.push({
          id: charId,
          title: `Characterize ${untested.join(", ")}`,
          status: "planning",
          difficulty: 2,
          routing: "direct",
          estimate: charEstimate,
          points: estimatePoints(2, history).points,
          zone3Tokens: 0,
        });
        result.held.push({ id: charId, reasons: [approvalHold(charId)] });
        result.characterized.push({ id: charId, before: id, files: untested });
      }
      if (!deps.includes(charId)) deps.push(charId);
    }

    // Criteria with stable ids, each linted (§2.3.2, PM-P1-5, PM-P1-17).
    const criteria = story.acceptanceTests.map((t) => t.assertion);
    const ids = criterionIdsFor(id, criteria.length);
    const lints = criteria.map((c) =>
      lintCriterion(c, { title: story.card.title, specText: plan.spec }),
    );

    // The staged test: example tables for the criteria with values, in the
    // project's own framework and test folder (PM-P1-19).
    const modelSymbol = story.interface?.[0];
    // A scope file from the repository's own names passes the same check as a
    // model's before it reaches a generated import line (B4.3 re-check).
    const file =
      modelSymbol?.file ??
      story.card.scopeFiles
        .filter((f) => !/\.(spec|test)\./.test(f))
        .map((f) => safeRepoRelativeFile(f))
        .find((f): f is string => f !== undefined);
    const symbol: CardInterfaceSymbol | undefined = file
      ? { symbol: modelSymbol?.symbol ?? heuristicSymbol(story), file, signature: "" }
      : undefined;
    const sampled: StagedCriterion[] = stagesTests
      ? story.acceptanceTests.map((t, i) => ({
          criterionId: ids[i] as string,
          criterion: t.assertion,
          rows: lints[i]?.ok ? (t.examples ?? exampleRows(t.assertion)) : [],
        }))
      : [];
    // PM-N7-2: at production or regulated, a must-have row the model wrote is
    // sampled again, independently; a disagreement is a person's to settle.
    const disputed: { criterion: StagedCriterion; args: unknown[]; values: [unknown, unknown] }[] =
      [];
    const disputedCriteria = new Set<string>();
    if (
      (profile === "production" || profile === "regulated") &&
      plan.source === "model_assisted" &&
      oracle &&
      symbol &&
      (await mustHave(requirementIds))
    ) {
      for (const c of sampled) {
        if (c.rows.length === 0) continue;
        const checked = await crossCheckRows(oracle, {
          spec: plan.spec ?? story.card.spec ?? story.card.title,
          symbol: { ...symbol, signature: modelSymbol?.signature ?? "" },
          rows: c.rows,
        });
        for (const d of checked.disputed) {
          disputed.push({ criterion: c, args: d.row.args, values: [d.row.expected, d.second] });
          disputedCriteria.add(c.criterionId);
        }
        c.rows = checked.kept;
      }
    }
    const staged = sampled.filter((c) => c.rows.length > 0);
    const basePath = story.acceptanceTests[0]?.filePath ?? `tests/${id}.spec.ts`;
    let rendered =
      symbol && staged.length > 0
        ? renderExampleTest({
            framework,
            testPath: basePath,
            title: story.card.title,
            symbol,
            cases: staged,
          })
        : undefined;
    const testPath = rendered
      ? freeTestPath(options.repoRoot, basePath, rendered.source)
      : basePath;
    if (rendered && testPath !== basePath && symbol) {
      rendered = renderExampleTest({
        framework,
        testPath,
        title: story.card.title,
        symbol,
        cases: staged,
      });
    }
    // PM-P1-15: the interface is what the staged test imports; its
    // signature the model's, else the one the example rows call.
    const rows = staged[0]?.rows ?? [];
    const iface: CardInterfaceSymbol[] = rendered
      ? interfaceFromTest(rendered.source, testPath).map((s) => ({
          ...s,
          signature:
            story.interface?.find((m) => m.symbol === s.symbol && m.signature)?.signature ??
            signatureFromRows(s.symbol, rows),
        }))
      : (story.interface ?? []);
    const covered = new Set((rendered?.cases ?? []).map((c) => c.criterionId));

    // PM-N7-1: an invariant criterion gets a property test with a fixed seed.
    const properties: {
      path: string;
      rendered: RenderedFile;
      criterionId: string;
      seed: number;
    }[] = [];
    if (symbol && stagesTests) {
      story.acceptanceTests.forEach((t, i) => {
        const cid = ids[i] as string;
        if (!lints[i]?.ok || !needsPropertyTest(t.assertion, profile)) return;
        const path = siblingPath(testPath, "property");
        const seed = propertySeed(cid);
        const other = story.interface?.find((s) => s.symbol !== symbol.symbol);
        properties.push({
          path,
          criterionId: cid,
          seed,
          rendered: renderPropertyTest({
            framework,
            testPath: path,
            title: story.card.title,
            symbol: { ...symbol, signature: modelSymbol?.signature ?? "" },
            criterionId: cid,
            criterion: t.assertion,
            rows: sampled[i]?.rows ?? [],
            seed,
            ...(other ? { inverse: other } : {}),
          }),
        });
        covered.add(cid);
      });
      if (properties.length > 0 && !hasDependency(options.repoRoot, "fast-check")) {
        proposeDependency(
          "fast-check",
          "the property-based tests of invariant criteria (planner-pm §2.17.4; approved, DEC-08 O6)",
        );
      }
    }

    // PM-N6-3: a base test asserting a value this card changes is superseded;
    // its new version is staged by the test-author step, never the Worker.
    const supersedes =
      hasHistory && options.repoRoot && symbol && needsCases
        ? supersededTests(
            options.repoRoot,
            symbol,
            staged.flatMap((c) => c.rows),
          ).map((t) => ({
            ...t,
            criterionId:
              staged.find((c) =>
                c.rows.some((r) => JSON.stringify(r.args) === JSON.stringify(t.args)),
              )?.criterionId ?? (ids[0] as string),
          }))
        : [];
    const supersedingPath = siblingPath(testPath, "supersedes");
    const superseding =
      supersedes.length > 0 && symbol
        ? renderSupersedingTest({
            framework,
            testPath: supersedingPath,
            symbol,
            superseded: supersedes,
          })
        : undefined;

    const difficulty = clampDifficulty(story.difficulty.value);
    const points = estimatePoints(difficulty, history);
    const spec = story.card.spec ?? `${story.card.title}\n\n${story.rationale}`;
    const acceptanceTests = [
      ...(rendered ? [testPath] : []),
      ...properties.map((p) => p.path),
      ...(superseding ? [supersedingPath] : []),
    ];
    // PM-14: Zone 3 measured on the card as it will be stored, from the same
    // sources the `ready` entry condition reads. Every staged file this card
    // carries is passed here, not only the base example table: the property
    // and superseding files are written to disk only after `createCard`
    // below, so without their source `zone3Fit` would silently omit them
    // (a repo-root read of a file that does not exist yet returns nothing).
    const testSources: Record<string, string> = {
      ...(rendered ? { [testPath]: rendered.source } : {}),
      ...Object.fromEntries(properties.map((p) => [p.path, p.rendered.source])),
      ...(superseding ? { [supersedingPath]: superseding.source } : {}),
    };
    const measured = zone3Fit(
      {
        id,
        title: story.card.title,
        spec,
        acceptanceCriteria: criteria,
        scopeFiles: story.card.scopeFiles,
        acceptanceTests,
        interface: iface,
      },
      {
        promptBudgetTokens: promptBudget,
        repoRoot: options.repoRoot,
        ...(Object.keys(testSources).length > 0 ? { testSources } : {}),
      },
    ).tokens;
    const zone3Tokens = options.repoRoot ? measured : Math.max(measured, story.estimatedPackTokens);

    // Why it cannot be Ready yet, each naming what would unblock it.
    const holds: string[] = [...investHolds(id)];
    const ceiling = ceilings.get(id);
    if (ceiling) holds.push(`Capability ceiling: ${ceiling.smallestHumanAction}`);
    if (story.splitDepth >= 4 && holds.length > 0) {
      holds.push(`At split depth ${story.splitDepth} it is not split again.`);
    }
    if (zone3Tokens > cap) {
      holds.push(
        `INVEST Small: its Zone 3 content is ${zone3Tokens} tokens, over Zone 3's cap of ${cap}; split it.`,
      );
    }
    if (story.card.stepBudget > INVEST_MAX_STEPS) {
      holds.push(
        `INVEST Small: its step budget is ${story.card.stepBudget}, over ${INVEST_MAX_STEPS}; split it.`,
      );
    }
    ids.forEach((cid, i) => {
      const lint = lints[i];
      if (lint && !lint.ok) {
        holds.push(
          `Criterion ${cid} refused by the lint (${lint.problems.map((p) => p.code).join(", ")}): restate it with a concrete example.`,
        );
      } else if (!covered.has(cid) && needsCases && !disputedCriteria.has(cid)) {
        holds.push(`Criterion ${cid} has no staged test case.`);
      }
    });
    // PM-N3-2: a card the Worker's record says it will likely fail, which the
    // planner could not split, waits in Planning with the numbers.
    const capability = options.capability
      ? capabilityVerdict(options.capability, { kind: KIND_OF_SLICE[story.slice], difficulty })
      : undefined;
    if (capability?.shouldSplit && capability.reason) holds.push(capability.reason);
    if (holdingId) holds.unshift(waitingReason(holdingId));
    // PM-N7-5: every card waits for a person's approval of its criteria.
    holds.push(approvalHold(id));

    const status: CardStatus =
      holds.length > 0 ? "planning" : deps.length === 0 ? "ready" : "backlog";
    const blockedReason = holds.length > 0 ? holds.join(" ") : undefined;
    if (holds.length > 0) result.held.push({ id, reasons: holds });

    const input: CreateCardInput = {
      id,
      tier: story.card.tier,
      parentId: options.epicId,
      title: story.card.title,
      status,
      scopeFiles: story.card.scopeFiles,
      stepBudget: story.card.stepBudget,
      spec,
      acceptanceCriteria: criteria,
      criterionIds: ids,
      acceptanceTests,
      difficulty,
      estimate: points.points,
      tokenBudget: estimate(estimator, story).tokens,
      secondsBudget: estimate(estimator, story).seconds,
      modelRoute: modelRouteFor(story.routing),
      // DEC-26: three stored fields, never a title suffix (PM-P1-11/12/13).
      kind: KIND_OF_SLICE[story.slice],
      change,
      ...(supersedes.length > 0 ? { supersedes: supersedes.map((t) => t.test) } : {}),
      split: storySplitAxis ?? null,
      ...(story.splitDepth > 0 ? { splitDepth: story.splitDepth } : {}),
      ...(iface.length > 0 ? { interface: iface } : {}),
      // A cross-repository part names its repository (RG-N3-2); a card
      // planned without a model says so (PM-P1-3).
      labels: [
        story.slice,
        `route:${story.routing}`,
        ...(story.card.labels ?? []).filter((l) => l.startsWith("repo:")),
        ...(heuristic ? ["no-model"] : []),
      ],
      ...(deps.length > 0 ? { dependsOn: deps } : {}),
      // What the planned card declares to its gates: DOM assertions and
      // intended overlaps for the visual gate, a refactor's surface change,
      // an upgrade's kept tests (GT-N4-4, GT-N4-6, GT-TQ-8, GT-TQ-11).
      ...(story.card.gateChecks ? { gateChecks: story.card.gateChecks } : {}),
      ...(blockedReason ? { blockedReason } : {}),
      ...(projectId ? { projectId } : {}),
    };
    await store.createCard(input, actor);
    createdIds.add(id);
    for (const requirementId of requirementIds) {
      await store.requirements.link({ requirementId, from: "card", ref: id }, actor);
    }
    if (rendered) {
      if (options.repoRoot) {
        const abs = join(options.repoRoot, testPath);
        mkdirSync(dirname(abs), { recursive: true });
        if (!existsSync(abs)) writeFileSync(abs, rendered.source);
      }
      await store.stagedTests.stage(
        {
          cardId: id,
          path: testPath,
          sha256: createHash("sha256").update(rendered.source).digest("hex"),
          author: "planner",
          cases: rendered.cases,
        },
        actor,
      );
      await recordExamples(ledger, { cardId: id, path: testPath, cases: staged });
    }
    for (const p of properties) {
      writeStaged(options.repoRoot, p.path, p.rendered.source);
      await store.stagedTests.stage(
        {
          cardId: id,
          path: p.path,
          sha256: createHash("sha256").update(p.rendered.source).digest("hex"),
          author: "planner",
          cases: p.rendered.cases,
        },
        actor,
      );
      await appendPlannerEvent(
        ledger,
        "test/property_staged",
        { cardId: id, criterionId: p.criterionId, path: p.path, seed: p.seed },
        { cardId: id },
      );
    }
    if (superseding) {
      writeStaged(options.repoRoot, supersedingPath, superseding.source);
      await store.stagedTests.stage(
        {
          cardId: id,
          path: supersedingPath,
          sha256: createHash("sha256").update(superseding.source).digest("hex"),
          // The test-author step's (the author field); the ledger's actor is the planner.
          author: "test-author",
          cases: superseding.cases,
        },
        actor,
      );
      result.superseded.push({ id, tests: supersedes.map((t) => t.test) });
    }
    // PM-N7-2: each disputed row is a decision showing both values; the card
    // waits on it in Planning, and the answer is staged.
    const waits: string[] = [];
    for (const d of disputed) {
      if (!symbol) break;
      const shown = d.values.map((v) => JSON.stringify(v));
      const built = buildDecisionRequest({
        cardId: id,
        category: "vagueness",
        question: `Which value is right for ${symbol.symbol} given ${JSON.stringify(d.args)} (criterion ${d.criterion.criterionId})? Two independent samples disagree: ${shown.join(" or ")}.`,
        optionLabels: shown,
        sourceExcerpt: d.criterion.criterion,
      });
      const oracleDispute: OracleDispute = {
        cardId: id,
        criterionId: d.criterion.criterionId,
        criterion: d.criterion.criterion,
        absPath: options.repoRoot ? join(options.repoRoot, testPath) : testPath,
        path: testPath,
        framework,
        title: story.card.title,
        symbol,
        args: d.args,
        values: d.values,
      };
      const request: DecisionRequest = {
        ...built,
        // Neither sample is chosen by default: a person picks.
        policy: "default_deny",
        defaultIfNoAnswer: { deadline: built.defaultIfNoAnswer.deadline },
        oracle: oracleDispute,
      };
      const decision = await new DecisionStore(ledger).request(request, { park: false });
      waits.push(waitingReason(decision));
      result.disputes.push({ id, decisionId: decision });
    }
    if (waits.length > 0) {
      const reasons = [...waits, ...holds];
      await store.updateCard(id, { blockedReason: reasons.join(" ") }, actor);
      const held = result.held.find((h) => h.id === id);
      if (held) held.reasons = reasons;
    }
    // PM-N6-5: a fix card's candidate lines, ranked from its reproduction's
    // coverage against the base tests that execute its scope.
    if (
      change === "fix" &&
      hasHistory &&
      options.repoRoot &&
      rendered &&
      options.localise !== false
    ) {
      const run = testCommand(options.repoRoot, framework);
      if (run) {
        const reaching = testsReaching(options.repoRoot);
        const passing = [
          ...new Set(story.card.scopeFiles.flatMap((f) => reaching.get(f) ?? [])),
        ].map((t) => run(t));
        await localiseFix(ledger, {
          cardId: id,
          root: options.repoRoot,
          failing: [run(testPath)],
          passing,
        });
      }
    }
    const cardEstimate = estimate(estimator, story);
    const builtFor = traces.capabilityByStory.get(id);
    result.created.push({
      id,
      title: story.card.title,
      status,
      difficulty,
      routing: story.routing,
      estimate: cardEstimate,
      points: points.points,
      zone3Tokens,
      ...(builtFor ? { capability: builtFor } : {}),
    });
    if (points.points >= SPLIT_POINTS) {
      result.proposedSplits.push({ id, title: story.card.title, points: points.points });
    }

    const notes: string[] = [];
    if (heuristic) notes.push(PLANNED_WITHOUT_MODEL);
    const impact = options.repoRoot
      ? await analyzeImpact(options.repoRoot, story.card.scopeFiles).catch(() => undefined)
      : undefined;
    if (story.routing === "edit_sketch" && options.sketcher) {
      const r = await sketchWithModel(options.sketcher, story, {
        ...(options.repoRoot ? { repoRoot: options.repoRoot } : {}),
        ...(impact ? { blastRadius: impact.blastRadius } : {}),
        ...(options.plannerTools ? { tools: options.plannerTools } : {}),
      });
      result.sketches.push({
        id,
        source: r.source,
        ...(r.rejected ? { rejected: r.rejected } : {}),
      });
      notes.push(formatEditSketch(r.sketch));
    } else if (story.editSketch) {
      notes.push(
        formatEditSketch(
          impact
            ? {
                ...story.editSketch,
                blastRadius: [
                  ...new Set([...story.editSketch.blastRadius, ...impact.blastRadius]),
                ].sort(),
              }
            : story.editSketch,
        ),
      );
    }
    if (impact && impact.blastRadius.length > 0) {
      notes.push(
        `Impact: a change here can break ${impact.blastRadius.join(", ")}${impact.tests.length ? `; run ${impact.tests.join(", ")}` : ""}.`,
      );
    }
    if (capability) notes.push(capability.note);
    if (superseding) {
      notes.push(
        `Supersedes base tests whose expectation this card changes: ${supersedes.map((t) => `${t.test} (was ${JSON.stringify(t.was)}, now ${JSON.stringify(t.now)})`).join("; ")}. Their new versions are staged at ${supersedingPath}; do not edit the base tests.`,
      );
    }
    for (const p of properties) {
      notes.push(
        `Property test for ${p.criterionId} staged at ${p.path} with the fixed seed ${p.seed} (fast-check).`,
      );
    }
    notes.push(
      `Criterion lint: ${ids
        .map((cid, i) => {
          const lint = lints[i];
          return lint?.ok
            ? `${cid} ok`
            : `${cid} refused (${lint?.problems.map((p) => p.code).join(", ")})`;
        })
        .join("; ")}.`,
    );
    if (rendered) {
      const table = staged.flatMap((c) =>
        c.rows.map(
          (r) =>
            `${c.criterionId}: given ${JSON.stringify(r.args)} → ${JSON.stringify(r.expected)}`,
        ),
      );
      notes.push(
        `Acceptance test staged at ${testPath} (the harness wrote it; it must fail before the change). Examples: ${table.join("; ")}.`,
      );
    }
    if (iface.length > 0) {
      notes.push(
        `Interface the acceptance test expects: ${iface.map((s) => `${s.signature || s.symbol} from ${s.file}`).join("; ")}.`,
      );
    }
    if (plan.ambiguity.assumptions.length > 0) {
      notes.push(
        `Planner assumptions (tell the team if one is wrong): ${plan.ambiguity.assumptions
          .map((a) => a.statement)
          .join(" ")}`,
      );
    }
    notes.push(
      `Estimate: ${points.points} pts (${points.basis === "history" ? `median of ${points.samples} finished cards of this difficulty` : "prior from difficulty"}); ${cardEstimate.tokens} tokens (${cardEstimate.tokensRange[0]}-${cardEstimate.tokensRange[1]}), ${cardEstimate.seconds}s, basis ${cardEstimate.basis.kind} (${cardEstimate.basis.samples} samples of ${cardEstimate.basis.cardClass}).`,
    );
    for (const text of notes) {
      await store.recordDossierEntry({ cardId: id, kind: "note", text, actor: "planner" });
    }
  }

  // Assumptions are logged on the epic, one event each (P8, feeds P15).
  for (const a of plan.ambiguity.assumptions) {
    await appendPlannerEvent(
      ledger,
      ASSUMPTION_EVENTS.logged,
      { ...a, cardId: options.epicId },
      { cardId: epic ? options.epicId : undefined },
    );
  }

  const previous = await ledger.log.getEventsByTypes(["plan/created"]);
  result.version =
    previous.filter((e) => (e.payload as { epicId?: string }).epicId === options.epicId).length + 1;
  await appendPlannerEvent(
    ledger,
    "plan/created",
    {
      epicId: options.epicId,
      version: result.version,
      source: plan.source,
      stories: plan.stories.map((s) => ({
        id: s.card.id,
        title: s.card.title,
        slice: s.slice,
        scopeFiles: s.card.scopeFiles,
        difficulty: s.difficulty.value,
        routing: s.routing,
        dependsOn: s.dependsOn,
      })),
      rejected: result.rejected.map((r) => r.id),
      held: result.held.map((h) => h.id),
      proposedChanges: result.proposedChanges.map((c) => c.id),
      proposedSplits: result.proposedSplits.map((c) => c.id),
      epics: result.epics.map((e) => e.id),
      invest: { passed: invest.passed, checks: invest.checks.map((c) => [c.check, c.passed]) },
    },
    { cardId: epic ? options.epicId : undefined },
  );

  return result;
}

/** The machine estimate of a story, from the estimation model. */
function estimate(estimator: EstimationModel, story: PlannedStory): CardEstimate {
  return estimator.estimateStory(story);
}

/**
 * One line per story and every INVEST check, for `sekhemet plan`. A plan
 * made without a model says so as its first line (PM-P1-3).
 */
export function formatPlanReport(result: PersistPlanResult): string {
  const lines = [
    ...(result.source === "heuristic" ? [PLANNED_WITHOUT_MODEL] : []),
    `Plan v${result.version}: ${result.created.length} cards created, ${result.rejected.length} rejected, ${result.held.length} held in Planning.`,
  ];
  for (const c of result.created) {
    lines.push(
      `  [${c.status}] ${c.id}: ${c.title} (${c.points} pts, difficulty ${c.difficulty}, ${c.routing}, ${c.zone3Tokens} Zone 3 tokens, ~${c.estimate.tokens} tokens, ${c.estimate.basis.kind})`,
    );
  }
  for (const h of result.held) lines.push(`  [held] ${h.id}: ${h.reasons.join(" ")}`);
  for (const r of result.rejected) lines.push(`  [rejected] ${r.id}: ${r.title} - ${r.reason}`);
  for (const s of result.serialized) {
    lines.push(`  [serialized] ${s.id} after active ${s.after} (shares ${s.files.join(", ")})`);
  }
  for (const e of result.epics) {
    lines.push(
      `  Re-split as an epic: ${e.title} (${e.id}) — a ${e.mechanism} is many cards, not one; plan it on its own.`,
    );
  }
  for (const c of result.proposedChanges) {
    lines.push(`  Proposed change (not a card): ${c.title} — ${c.reason}.`);
  }
  for (const s of result.proposedSplits) {
    lines.push(
      `  Proposed split: ${s.id} "${s.title}" is ${s.points} pts; split it before it runs.`,
    );
  }
  for (const r of result.modelRefusals)
    lines.push(`  The planning model's reply was refused: ${r}.`);
  lines.push("INVEST pre-flight:");
  for (const check of result.invest.checks) {
    lines.push(`  ${check.passed ? "pass" : "FAIL"} ${check.check}: ${check.detail}`);
  }
  const decisions =
    result.decisions ?? (result.decisionId ? [{ id: result.decisionId, holds: true }] : []);
  for (const d of decisions) {
    lines.push(
      d.holds
        ? `Decision ${d.id} is waiting on you; the new cards stay in Planning until it is answered.`
        : `Decision ${d.id} is open; planning proceeds on its default until you answer it.`,
    );
  }
  return lines.join("\n");
}

export type { CardRecord };
