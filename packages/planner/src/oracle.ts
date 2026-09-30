import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CardInterfaceSymbol } from "@sekhemet/kernel";
import type { LocalInferenceAdapter } from "@sekhemet/models";
import { extractJsonObject, plannerCopy } from "@sekhemet/models";
import type { ExampleRow } from "./criteria.js";
import type { PlannerLedger } from "./ledger.js";
import { type StagedCriterion, type TestFramework, renderExampleTest } from "./staging.js";

/**
 * The oracle cross-check (planner-pm §2.17.4, PM-N7-2): at production or
 * regulated, the expected value of each must-have example row is sampled a
 * second time, independently of the first — the second sample sees the
 * spec, the interface and the call, never the first sample's criterion or
 * value. A disagreement is not settled by either sample: the row is left out
 * of the staged table and a decision request shows both values; the answer
 * is staged (`applyOracleAnswer`), which voids any approval of the old file.
 */

/** A staged table's rows, recorded with each staging (`test/examples`, rows private). */
export const EXAMPLES_EVENT = "test/examples";

export interface OracleDispute {
  cardId: string;
  criterionId: string;
  criterion: string;
  /** The staged test, absolute on disk and as staged. */
  absPath: string;
  path: string;
  framework: TestFramework;
  title: string;
  symbol: CardInterfaceSymbol;
  args: unknown[];
  /** The two samples, in the order the decision shows them. */
  values: [unknown, unknown];
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** One independent sample of what a call returns, or undefined when the model cannot say. */
export async function sampleExpected(
  adapter: LocalInferenceAdapter,
  input: { spec: string; symbol: CardInterfaceSymbol; args: readonly unknown[] },
): Promise<{ value: unknown } | undefined> {
  const call = `${input.symbol.symbol}(${input.args.map((a) => JSON.stringify(a)).join(", ")})`;
  try {
    const res = await adapter.generate({
      systemPrompt: plannerCopy.oracleSystem,
      prompt: [
        `Specification:\n${input.spec}`,
        `Function: ${input.symbol.signature || input.symbol.symbol} in ${input.symbol.file}`,
        plannerCopy.oracleQuestion(call),
      ].join("\n\n"),
      toolArm: adapter.supportedArms[0] ?? "arm_a_flat",
      temperature: 0,
      // The Planning model's, whichever queue its weights serve first (measurement rule 4a).
      role: "planner",
      task: "oracle_sample",
    });
    const parsed = extractJsonObject(res.text) as { expected?: unknown } | undefined;
    if (!parsed || !("expected" in parsed)) return undefined;
    return { value: parsed.expected };
  } catch {
    return undefined;
  }
}

/**
 * PM-N7-2: sample each row again; rows whose second sample differs are
 * disputed (a row the model cannot answer again stays, unconfirmed).
 */
export async function crossCheckRows(
  adapter: LocalInferenceAdapter,
  input: { spec: string; symbol: CardInterfaceSymbol; rows: readonly ExampleRow[] },
): Promise<{ kept: ExampleRow[]; disputed: { row: ExampleRow; second: unknown }[] }> {
  const kept: ExampleRow[] = [];
  const disputed: { row: ExampleRow; second: unknown }[] = [];
  for (const row of input.rows) {
    const second = await sampleExpected(adapter, {
      spec: input.spec,
      symbol: input.symbol,
      args: row.args,
    });
    // A failed second sample (the model could not answer again) confirms
    // nothing: the row is neither kept nor disputed, only left out, as the
    // function's own contract says ("a row the model cannot answer again
    // stays, unconfirmed") — kept was wrongly the default before this fix.
    if (!second) continue;
    if (!same(second.value, row.expected)) disputed.push({ row, second: second.value });
    else kept.push(row);
  }
  return { kept, disputed };
}

/** Record the rows a staged table carries (private: example values can be a person's data). */
export async function recordExamples(
  ledger: PlannerLedger,
  input: { cardId: string; path: string; cases: readonly StagedCriterion[] },
): Promise<void> {
  await ledger.log.append({
    actor: "planner",
    type: EXAMPLES_EVENT,
    cardId: input.cardId,
    payload: {
      cardId: input.cardId,
      path: input.path,
      criterionIds: input.cases.map((c) => c.criterionId),
      rows: input.cases.reduce((n, c) => n + c.rows.length, 0),
    },
    private: { cases: input.cases },
  });
}

/** The latest rows of each staged table of a card, by path. */
export async function stagedExamples(
  ledger: PlannerLedger,
  cardId: string,
): Promise<Map<string, StagedCriterion[]>> {
  const out = new Map<string, StagedCriterion[]>();
  for (const e of await ledger.log.getEventsByCardAndTypes(cardId, [EXAMPLES_EVENT])) {
    const path = (e.payload as { path?: string }).path;
    const cases = (e.private as { cases?: unknown } | undefined)?.cases;
    if (path && Array.isArray(cases)) out.set(path, cases as StagedCriterion[]);
  }
  return out;
}

/**
 * A person's answer to a disputed row: the row is added to its criterion's
 * table with the chosen value, the file rewritten and staged again (a new
 * SHA-256, so an approval of the old content is void, PM-N7-4).
 */
export async function applyOracleAnswer(
  ledger: PlannerLedger,
  dispute: OracleDispute,
  optionIndex: number,
): Promise<void> {
  const chosen = dispute.values[optionIndex];
  if (optionIndex < 0 || optionIndex >= dispute.values.length) return;
  const current = (await stagedExamples(ledger, dispute.cardId)).get(dispute.path) ?? [];
  const row = { args: dispute.args, expected: chosen };
  const cases = current.some((c) => c.criterionId === dispute.criterionId)
    ? current.map((c) =>
        c.criterionId === dispute.criterionId ? { ...c, rows: [...c.rows, row] } : c,
      )
    : [...current, { criterionId: dispute.criterionId, criterion: dispute.criterion, rows: [row] }];
  const rendered = renderExampleTest({
    framework: dispute.framework,
    testPath: dispute.path,
    title: dispute.title,
    symbol: dispute.symbol,
    cases,
  });
  mkdirSync(dirname(dispute.absPath), { recursive: true });
  writeFileSync(dispute.absPath, rendered.source);
  // A table staged only once its first row was settled joins the card's tests.
  const card = await ledger.store.getCard(dispute.cardId);
  if (card && !(card.acceptanceTests ?? []).includes(dispute.path)) {
    await ledger.store.updateCard(
      dispute.cardId,
      { acceptanceTests: [...(card.acceptanceTests ?? []), dispute.path] },
      "planner",
    );
  }
  await ledger.store.stagedTests.stage(
    {
      cardId: dispute.cardId,
      path: dispute.path,
      sha256: createHash("sha256").update(rendered.source).digest("hex"),
      author: "planner",
      cases: rendered.cases,
    },
    "planner",
  );
  await recordExamples(ledger, { cardId: dispute.cardId, path: dispute.path, cases });
}
