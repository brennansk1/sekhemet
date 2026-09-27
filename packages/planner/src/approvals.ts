import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { type DepthProfile, planningExitFailure } from "@sekhemet/board";
import {
  type CardInterfaceSymbol,
  type CardRecord,
  type CardStore,
  canonicalJson,
  depthProfileOf,
  parseDepthProfile,
} from "@sekhemet/kernel";
import { approvalHold } from "./approval_hold.js";
import type { ExampleRow } from "./criteria.js";
import { type PlannerLedger, moveCard } from "./ledger.js";
import { stagedExamples } from "./oracle.js";
import type { RenderedTest, TestFramework } from "./staging.js";

/**
 * Who approves criteria and tests (planner-pm §2.17, NEW-planner-pm-7,
 * PM-N7-1…5). The depth profile is the one a person recorded (design-stage
 * P14), read by `resolveDepthProfile`; `internal tool` (`DEFAULT_DEPTH_PROFILE`)
 * only when none is recorded. A person approves every card's criteria before it leaves
 * Planning; production approves the example tables of must-have
 * requirements, regulated every staged acceptance-test file; the board's
 * Planning exit condition (`planningExitFailure`) checks the records, each
 * bound to a SHA-256 so a change voids it. At production and regulated an
 * invariant criterion gets a property test with a fixed seed.
 */

export type { DepthProfile } from "@sekhemet/board";
export { DEFAULT_DEPTH_PROFILE } from "@sekhemet/board";

/**
 * The depth profile a plan is made and approved under (design-stage
 * DS-P14-3): from a ledger, the one a person recorded for the project, read
 * by the kernel's one function (`depthProfileOf`) — internal tool only when
 * none is recorded; from a configured name, that profile, and the unrecorded
 * default for none or an unknown one.
 */
export function resolveDepthProfile(
  source?: { store: CardStore } | string,
  projectId?: string,
): DepthProfile {
  if (typeof source === "string") {
    return parseDepthProfile(source) ?? depthProfileOf(undefined).profile;
  }
  return source
    ? source.store.depthProfiles.of(projectId).profile
    : depthProfileOf(undefined).profile;
}

/** The words that make a criterion an invariant (§2.17.4). */
const INVARIANT =
  /\b(never|always|exactly once|idempotent(ly)?|for any|for all|for every)\b|\bround[- ]?trip/i;

/** PM-N7-1: a criterion that gets a property-based test at this profile. */
export function needsPropertyTest(criterion: string, profile: DepthProfile): boolean {
  return (profile === "production" || profile === "regulated") && INVARIANT.test(criterion);
}

/** A fixed seed for a criterion: the same criterion id always gets the same one. */
export function propertySeed(criterionId: string): number {
  return createHash("sha256").update(criterionId).digest().readUInt32BE(0) & 0x7fffffff;
}

/** Whether the project already has a development (or runtime) dependency. */
export function hasDependency(root: string | undefined, name: string): boolean {
  if (!root) return false;
  const p = join(root, "package.json");
  if (!existsSync(p)) return false;
  try {
    const pkg = JSON.parse(readFileSync(p, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return name in { ...pkg.dependencies, ...pkg.devDependencies };
  } catch {
    return false;
  }
}

function importPath(testPath: string, file: string): string {
  let rel = posix.relative(posix.dirname(testPath), file).replace(/\.tsx?$/, ".js");
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel;
}

/** A fast-check arbitrary for a value like this example's. */
function arbitraryFor(v: unknown): string {
  if (typeof v === "number") {
    return Number.isInteger(v)
      ? "fc.integer({ min: -1_000_000, max: 1_000_000 })"
      : "fc.double({ noNaN: true })";
  }
  if (typeof v === "string") return "fc.string()";
  if (typeof v === "boolean") return "fc.boolean()";
  if (Array.isArray(v)) return `fc.array(${arbitraryFor(v[0] ?? 0)})`;
  return "fc.anything()";
}

/** The argument types a signature names (`name: number`), as example values. */
function argsFromSignature(signature: string): unknown[] | undefined {
  const inner = /\(([^)]*)\)/.exec(signature)?.[1];
  if (inner === undefined) return undefined;
  return inner
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const type = p.split(":")[1]?.trim() ?? "";
      if (/^number/.test(type)) return 0;
      if (/^string/.test(type)) return "";
      if (/^boolean/.test(type)) return false;
      if (/\[\]$|^Array/.test(type)) return [0];
      return 0;
    });
}

/**
 * PM-N7-1: a property-based test (fast-check, DEC-08 O6) for an invariant
 * criterion, with a fixed seed. What it asserts, from the criterion's words:
 * a round trip through a named inverse returns the input; a numeric bound
 * ("never negative", "always at least N") holds for any input; otherwise —
 * idempotent, exactly once, never, always, for any — the same input gives
 * the same outcome every time (a retried call returns the original result).
 */
export function renderPropertyTest(input: {
  framework: TestFramework;
  testPath: string;
  title: string;
  symbol: CardInterfaceSymbol;
  criterionId: string;
  criterion: string;
  rows: readonly ExampleRow[];
  seed: number;
  /** The other symbol of a round trip (decode for encode), when the card names one. */
  inverse?: CardInterfaceSymbol;
}): RenderedTest {
  const { framework, symbol } = input;
  const sample = input.rows[0]?.args ?? argsFromSignature(symbol.signature) ?? ([0] as unknown[]);
  const arbs = sample.map(arbitraryFor);
  const params = sample.map((_, i) => `a${i}`);
  const text = input.criterion.toLowerCase();
  const name = `${input.criterionId}: property — ${input.criterion.replace(/\s+/g, " ").trim()}`;
  const eq = framework === "node" ? "assert.deepEqual" : "expect";
  const lines: string[] = [];
  if (framework === "vitest") lines.push('import { describe, expect, it } from "vitest";');
  if (framework === "node") {
    lines.push(
      'import assert from "node:assert/strict";',
      'import { describe, it } from "node:test";',
    );
  }
  lines.push('import fc from "fast-check";');
  const imported = [symbol, ...(input.inverse ? [input.inverse] : [])];
  for (const s of imported) {
    lines.push(`import { ${s.symbol} } from "${importPath(input.testPath, s.file)}";`);
  }
  lines.push(
    "",
    "// Staged by the planner: a property of the invariant its title names, with a fixed seed.",
  );
  lines.push(
    "const outcome = async (run: () => unknown) => {",
    "  try {",
    "    return { value: await run() };",
    "  } catch (err) {",
    "    return { error: err instanceof Error ? err.message : String(err) };",
    "  }",
    "};",
    "",
  );
  lines.push(`describe(${JSON.stringify(input.title)}, () => {`);
  lines.push(`  it(${JSON.stringify(name)}, async () => {`);
  lines.push("    await fc.assert(");
  lines.push(`      fc.asyncProperty(${arbs.join(", ")}, async (${params.join(", ")}) => {`);
  const call = `${symbol.symbol}(${params.join(", ")})`;
  const bound =
    /\bnever negative\b|\balways (non-negative|at least 0|zero or more)\b/.exec(text) ?? undefined;
  const positive = /\balways positive\b|\bnever (zero or )?(negative or zero|below one)\b/.exec(
    text,
  );
  if (/round[- ]?trip/.test(text) && input.inverse) {
    lines.push(
      `        const back = await ${input.inverse.symbol}(await ${call});`,
      framework === "node"
        ? `        ${eq}(back, ${params[0]});`
        : `        ${eq}(back).toEqual(${params[0]});`,
    );
  } else if (bound || positive) {
    const op = positive ? "> 0" : ">= 0";
    // A property that skips its assertion whenever the call does not
    // return a number cannot fail against a stub that returns nothing, or
    // throws: it must not cover the criterion (a criterion asserting a
    // numeric bound is unmet by anything that is not a number).
    lines.push(
      `        const got = await outcome(() => ${call});`,
      `        if (!("value" in got) || typeof got.value !== "number") {`,
      framework === "node"
        ? `          assert.fail(\`${symbol.symbol} did not return a number: \${JSON.stringify(got)}\`);`
        : `          throw new Error(\`${symbol.symbol} did not return a number: \${JSON.stringify(got)}\`);`,
      "        }",
      framework === "node"
        ? `        assert.ok(got.value ${op});`
        : `        expect(got.value ${op}).toBe(true);`,
    );
  } else {
    // Determinism alone ("same outcome twice") is vacuous for an empty
    // export: a stub that always throws or always returns undefined is
    // perfectly deterministic. Requiring a real, defined result first is
    // the minimum a property can ask without inventing semantics the
    // criterion's words do not state.
    lines.push(
      `        const first = await outcome(() => ${call});`,
      `        const again = await outcome(() => ${call});`,
      `        if ("error" in first) {`,
      framework === "node"
        ? `          assert.fail(\`${symbol.symbol} threw: \${first.error}\`);`
        : `          throw new Error(\`${symbol.symbol} threw: \${first.error}\`);`,
      "        }",
      "        if (first.value === undefined) {",
      framework === "node"
        ? `          assert.fail(\`${symbol.symbol} returned undefined\`);`
        : `          throw new Error(\`${symbol.symbol} returned undefined\`);`,
      "        }",
      framework === "node"
        ? `        ${eq}(again, first);`
        : `        ${eq}(again).toEqual(first);`,
    );
  }
  lines.push("      }),");
  lines.push(`      { seed: ${input.seed}, numRuns: 100 },`);
  lines.push("    );", "  });", "});", "");
  return { source: lines.join("\n"), cases: [{ name, criterionId: input.criterionId }] };
}

/** What a person is shown to approve a card (§2.17.2): its criteria and example tables, not test code. */
export interface ApprovalView {
  criteria: { id: string; text: string }[];
  /** One line per example row: `<criterion>: given <args> → <expected>`. */
  examples: string[];
  /** The staged files this profile asks a person to approve, each at its staged SHA-256. */
  tests: { path: string; what: "file" | "examples"; approved: boolean; sha256: string }[];
}

async function tracesToMustHave(ledger: PlannerLedger, cardId: string): Promise<boolean> {
  for (const l of ledger.store.requirements.linksFrom("card", cardId)) {
    if ((await ledger.store.requirements.get(l.requirementId))?.mustHave) return true;
  }
  return false;
}

async function testsToApprove(
  ledger: PlannerLedger,
  card: CardRecord,
  profile: DepthProfile,
): Promise<ApprovalView["tests"]> {
  if (profile !== "production" && profile !== "regulated") return [];
  if (profile === "production" && !(await tracesToMustHave(ledger, card.id))) return [];
  const what = profile === "regulated" ? "file" : "examples";
  return ledger.store.stagedTests.testApprovals(card.id).map((a) => ({
    path: a.path,
    what,
    approved: a.approved && (what !== "file" || a.what === "file"),
    sha256: a.stagedSha256,
  }));
}

export async function approvalView(
  ledger: PlannerLedger,
  cardId: string,
  depth?: DepthProfile,
): Promise<ApprovalView> {
  const card = await ledger.store.getCard(cardId);
  if (!card) throw new Error(`Card not found: ${cardId}`);
  const profile = depth ?? resolveDepthProfile(ledger, card.projectId);
  const ids = card.criterionIds ?? [];
  const criteria = ids.map((id, i) => ({ id, text: card.acceptanceCriteria?.[i] ?? "" }));
  const examples: string[] = [];
  for (const cases of (await stagedExamples(ledger, cardId)).values()) {
    for (const c of cases) {
      for (const r of c.rows) {
        examples.push(
          `${c.criterionId}: given ${JSON.stringify(r.args)} → ${JSON.stringify(r.expected)}`,
        );
      }
    }
  }
  return { criteria, examples, tests: await testsToApprove(ledger, card, profile) };
}

/** Take one hold out of a card's reason; the rest stay. */
export function withoutHold(reason: string | undefined, hold: string): string {
  return (reason ?? "")
    .replace(hold, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * A person approves one card (PM-N7-5, PM-N7-3): its criteria as they are
 * now and, by the profile, its example tables or staged files at their
 * current content; the approval hold is lifted, and a card with no other
 * hold leaves Planning — to Ready, or Backlog while it waits on another card
 * — through the board, which checks the same records.
 */
export async function approvePlannedCard(
  ledger: PlannerLedger,
  cardId: string,
  principal: string,
  options: { profile?: DepthProfile } = {},
): Promise<{ approved: boolean; released: boolean; held?: string }> {
  if (!principal) throw new Error("Criteria are approved by a person; no principal was given");
  const { store } = ledger;
  const card = await store.getCard(cardId);
  if (!card) throw new Error(`Card not found: ${cardId}`);
  const profile = options.profile ?? resolveDepthProfile(ledger, card.projectId);
  if ((card.criterionIds?.length ?? 0) === 0) return { approved: false, released: false };
  if (!store.stagedTests.criteriaApproval(cardId).approved) {
    await store.stagedTests.approveCriteria(cardId, principal);
  }
  for (const t of await testsToApprove(ledger, card, profile)) {
    if (t.approved) continue;
    const staged = store.stagedTests.staged(cardId).find((s) => s.path === t.path);
    if (!staged) continue;
    await store.stagedTests.approveTest(
      { cardId, path: t.path, sha256: staged.sha256, what: t.what },
      principal,
    );
  }
  const rest = withoutHold(card.blockedReason, approvalHold(cardId));
  if (rest !== (card.blockedReason ?? "").trim()) {
    await store.updateCard(cardId, { blockedReason: rest || null }, "planner");
  }
  if (card.status !== "planning" || rest) {
    return { approved: true, released: false, ...(rest ? { held: rest } : {}) };
  }
  const failure = await planningExitFailure(
    store,
    (await store.getCard(cardId)) as CardRecord,
    profile,
  );
  if (failure) return { approved: true, released: false, held: failure };
  const waiting = store.waitingOn(cardId);
  await moveCard(ledger, {
    cardId,
    from: "planning",
    to: waiting.length === 0 ? "ready" : "backlog",
    reason: `criteria approved by ${principal}`,
  });
  return { approved: true, released: true };
}

/**
 * A plan's approval refused because what the person was shown has changed
 * since (PM-N7-5 on the dashboard): a criterion, an example table or a
 * staged file. Nothing is recorded; `current` is what there is to approve now.
 */
export class StaleApprovalError extends Error {
  constructor(
    public readonly expected: string,
    public readonly current: PlanApproval,
  ) {
    super(
      `What was shown for approval has changed since (${expected.slice(0, 12)}, now ${current.sha256.slice(0, 12)}): look again, then approve what is there now.`,
    );
  }
}

/** One card of a plan as a person approves it: its view, and whether it already carries the approval. */
export interface PlanApprovalCard extends ApprovalView {
  id: string;
  title: string;
  status: CardRecord["status"];
  /** Its criteria, and every file the profile asks for, carry a person's approval as they are now. */
  approved: boolean;
  blockedReason?: string;
}

/**
 * What `approvePlan` would approve for a card or an epic (PM-N7-5), and one
 * SHA-256 of everything shown — the profile, each card's criteria, example
 * rows and staged files at their content — so an approval is bound to what
 * the person saw: the dashboard sends it back and a changed plan refuses it.
 */
export interface PlanApproval {
  id: string;
  profile: DepthProfile;
  cards: PlanApprovalCard[];
  sha256: string;
}

/** The cards a person's approval of `id` covers: it and its descendants, with criteria, not yet running. */
async function approvable(ledger: PlannerLedger, id: string): Promise<CardRecord[]> {
  const root = await ledger.store.getCard(id);
  if (!root) throw new Error(`Card not found: ${id}`);
  return [root, ...(await descendants(ledger, id))].filter(
    (c) => (c.criterionIds?.length ?? 0) > 0 && ["planning", "backlog", "ready"].includes(c.status),
  );
}

export async function planApprovalView(
  ledger: PlannerLedger,
  id: string,
  depth?: DepthProfile,
): Promise<PlanApproval> {
  const profile = depth ?? resolveDepthProfile(ledger, (await ledger.store.getCard(id))?.projectId);
  const cards: PlanApprovalCard[] = [];
  for (const c of await approvable(ledger, id)) {
    const view = await approvalView(ledger, c.id, profile);
    cards.push({
      id: c.id,
      title: c.title,
      status: c.status,
      approved:
        ledger.store.stagedTests.criteriaApproval(c.id).approved &&
        view.tests.every((t) => t.approved),
      ...(c.blockedReason ? { blockedReason: c.blockedReason } : {}),
      ...view,
    });
  }
  const shown = cards.map((c) => ({
    id: c.id,
    criteria: c.criteria,
    examples: c.examples,
    tests: c.tests.map((t) => ({ path: t.path, what: t.what, sha256: t.sha256 })),
  }));
  const sha256 = createHash("sha256")
    .update(canonicalJson({ id, profile, cards: shown }))
    .digest("hex");
  return { id, profile, cards, sha256 };
}

/** Every card under an epic, at any depth (a characterize card, an upgrade's fixes). */
async function descendants(ledger: PlannerLedger, id: string): Promise<CardRecord[]> {
  const out: CardRecord[] = [];
  const queue = [id];
  while (queue.length > 0) {
    const parentId = queue.shift() as string;
    for (const c of await ledger.store.listCards({ parentId })) {
      out.push(c);
      queue.push(c.id);
    }
  }
  return out;
}

/**
 * `sekhemet approve <epic|card>`: a person approves a card, or every card of
 * a plan still waiting for it (PM-N7-5), in dependency order so a card whose
 * prerequisite was just released can follow it.
 */
export async function approvePlan(
  ledger: PlannerLedger,
  id: string,
  principal: string,
  options: {
    profile?: DepthProfile;
    /**
     * The SHA-256 of the `planApprovalView` the person was shown: when the
     * plan no longer hashes to it, nothing is approved (`StaleApprovalError`).
     */
    expectedSha256?: string;
  } = {},
): Promise<{ approved: string[]; released: string[]; held: { id: string; reason: string }[] }> {
  if (!principal) throw new Error("Criteria are approved by a person; no principal was given");
  if (options.expectedSha256 !== undefined) {
    const now = await planApprovalView(ledger, id, options.profile);
    if (now.sha256 !== options.expectedSha256) {
      throw new StaleApprovalError(options.expectedSha256, now);
    }
  }
  const cards = await approvable(ledger, id);
  const out = {
    approved: [] as string[],
    released: [] as string[],
    held: [] as { id: string; reason: string }[],
  };
  for (const c of cards) {
    const r = await approvePlannedCard(ledger, c.id, principal, {
      ...(options.profile ? { profile: options.profile } : {}),
    });
    if (r.approved) out.approved.push(c.id);
    if (r.released) out.released.push(c.id);
    if (r.held) out.held.push({ id: c.id, reason: r.held });
  }
  return out;
}
