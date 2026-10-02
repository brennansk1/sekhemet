import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type GateFailure, gateCopy } from "@sekhemet/gates";
import { BlobStore, type CardRecord, type ContextPack, ledgerErasures } from "@sekhemet/kernel";
import {
  type InferenceRequest,
  type InferenceResponse,
  type ToolCall,
  type ToolCallFormat,
  type ToolDefinition,
  parseToolCallsFromText,
} from "@sekhemet/models";
import { findPlaceholders } from "./prompt_lint.js";
import type { ToolInterfaceSpec } from "./tool_interface.js";
import { buildWorkerPrompt } from "./worker_prompt.js";

/**
 * The step-replay screen (PROMPT_STANDARD rule 35.3). Prompts are run for
 * one model step each and code checks the reply: the tool call parses, no
 * tool outside the offered set is called, no placeholder is echoed, and in a
 * canonical state the right tool is chosen. It *screens*: the report says
 * what passed and failed, per check and per state, and never admits a
 * change — admission is the suite A/B's alone (rule 35.4, DEC-28).
 *
 * Two kinds of case. The canonical states are built from prompt inputs, so
 * they are rendered under the current templates. A recorded context pack
 * (kernel rule 17) holds the request as it was sent — its rendered text and
 * tool definitions, not the inputs that built them — so it can only be
 * replayed as stored, and its case says so.
 */

/** One model step: a subset of `LocalInferenceAdapter`, so a test passes a scripted fake. */
export interface StepReplayModel {
  modelId: string;
  generate(request: InferenceRequest): Promise<InferenceResponse>;
}

/** A call that is right in a canonical state: the tool, and the file when it matters. */
export interface ExpectedCall {
  tool: string;
  path?: string;
}

export interface ReplayCase {
  id: string;
  /** `current`: rendered now, under the current templates; `as-stored`: the recorded request. */
  rendering: "current" | "as-stored";
  /** Why a case is replayed as stored, or where it came from. */
  note?: string;
  request: InferenceRequest;
  /** The tools the request offers; a call to any other is a hallucinated tool. */
  offered: string[];
  /** The labelled right first calls, for a canonical state; absent otherwise. */
  expected?: ExpectedCall[];
}

export interface ReplayChecks {
  parses: boolean;
  offeredOnly: boolean;
  noPlaceholder: boolean;
  /** Only for a labelled (canonical) state. */
  rightTool?: boolean;
}

export interface ReplayCaseResult {
  id: string;
  rendering: ReplayCase["rendering"];
  checks: ReplayChecks;
  passed: boolean;
  /** The calls the reply made, by name. */
  calls: string[];
  problems: string[];
  /** The model step itself failed: not a check's failure, counted apart. */
  error?: string;
}

export interface StepReplayReport {
  modelId: string;
  /** Always false: the screen never admits a change (rule 35.3). */
  admits: false;
  passed: boolean;
  cases: ReplayCaseResult[];
  /** The checks over the cases whose model step ran (model errors are counted apart). */
  byCheck: Record<keyof ReplayChecks, { pass: number; fail: number }>;
  /** Cases whose model step failed, so nothing was checked. */
  modelErrors: number;
  /** The verdict on the cases rendered under the current templates: what a template change is screened by. */
  current: { cases: number; passed: boolean };
  /** The verdict on the recorded packs replayed as sent, apart. */
  asStoredVerdict: { cases: number; passed: boolean };
  /** Each canonical state's verdict. */
  byState: Record<string, boolean>;
  /** Cases replayed as stored rather than rendered under the current templates. */
  asStored: number;
}

// --- the canonical states ----------------------------------------------------

const SCOPE = "src/ledger.ts";
const TEST = "tests/ledger.spec.ts";

const card = (stepsUsed: number): CardRecord => ({
  id: "card_step_replay",
  tier: "task",
  title: "Ledger store",
  status: "in_progress",
  scopeFiles: [SCOPE],
  acceptanceTests: ["ledger.spec.ts"],
  stepBudget: 40,
  stepsUsed,
  createdAt: "2026-09-25T00:00:00.000Z",
  updatedAt: "2026-09-25T00:00:00.000Z",
});

const TEST_BODY = `import { describe, expect, it } from "vitest";
import { Ledger } from "../src/ledger.js";

describe("ledger", () => {
  it("appends entries in order", () => {
    const l = new Ledger();
    l.append({ amount: 5 });
    expect(l.list().map((e) => e.amount)).toEqual([5]);
  });
});
`;

const LEDGER_BODY = `export interface Entry {
  amount: number;
}

export class Ledger {
  private entries: Entry[] = [];
  append(entry: Entry): void {
    this.entries.push(entry);
  }
  list(): Entry[] {
    return this.entries;
  }
}
`;

const TYPECHECK_FAILURE: GateFailure = {
  rung: "typecheck",
  gate: "typecheck",
  exitCode: 2,
  errorExcerpt: `${SCOPE}(8,31): error TS2322: Type 'string' is not assignable to type 'number'.`,
  suggestedFixFiles: [SCOPE],
  location: { file: SCOPE, line: 8 },
  expected: "a type-correct program",
  actual: "TS2322: Type 'string' is not assignable to type 'number'.",
  minimalRepro: "pnpm typecheck",
  // The remedy the tsc parser sends for this code, from the gates copy module.
  suggestedAction: gateCopy.resolveCode("TS2322", SCOPE, "8"),
};

/**
 * The labelled canonical states, rendered under the current templates with
 * the Worker's tools as the session offers them. The label is what a Worker
 * that reads the prompt right does first:
 * - `first_step` (nothing written yet): read the acceptance test or the scope
 *   file, or write the scope file;
 * - `failing_typecheck` (a TS2322 stands in the scope file): edit or read the
 *   failing file;
 * - `ready_to_verify` (every scope file written, no failure): `finish_card`
 *   or `check`.
 */
export function canonicalStates(worker: {
  tools: ToolInterfaceSpec[];
  /** The native tool definitions, when the Worker's adapter sends them. */
  definitions?: ToolDefinition[];
  toolArm?: ToolCallFormat;
}): ReplayCase[] {
  const base = {
    tools: worker.tools,
    goal: "Store ledger entries and list them in order.",
    acceptanceCriteria: ["append adds one entry", "list returns the entries in order"],
    acceptanceTests: [{ path: TEST, content: TEST_BODY }],
    ...(worker.definitions ? { nativeToolSchemas: worker.definitions } : {}),
  };
  const render = (
    id: string,
    input: Parameters<typeof buildWorkerPrompt>[0],
    expected: ExpectedCall[],
  ): ReplayCase => {
    const built = buildWorkerPrompt(input);
    return {
      id,
      rendering: "current",
      request: {
        systemPrompt: built.systemPrompt,
        prompt: built.prompt,
        toolArm: worker.toolArm ?? "arm_a_flat",
        ...(worker.definitions ? { tools: worker.definitions } : {}),
      },
      offered: worker.tools.map((t) => t.name),
      expected,
    };
  };
  const writes = (path: string): ExpectedCall[] => [
    { tool: "edit", path },
    { tool: "write_file", path },
  ];
  return [
    render(
      "first_step",
      { ...base, card: card(0), scopeFiles: [{ path: SCOPE, content: "" }], readyToVerify: false },
      // The scope file is empty: writing it is right, editing it is not.
      [
        { tool: "read_file", path: TEST },
        { tool: "read_file", path: SCOPE },
        { tool: "write_file", path: SCOPE },
      ],
    ),
    render(
      "failing_typecheck",
      {
        ...base,
        card: card(6),
        scopeFiles: [
          {
            path: SCOPE,
            content: LEDGER_BODY.replace(
              "this.entries.push(entry);",
              'this.entries.push({ amount: "5" });',
            ),
          },
        ],
        gateFailures: [TYPECHECK_FAILURE],
        readyToVerify: false,
      },
      [...writes(SCOPE), { tool: "read_file", path: SCOPE }],
    ),
    render(
      "ready_to_verify",
      {
        ...base,
        card: card(4),
        scopeFiles: [{ path: SCOPE, content: LEDGER_BODY }],
        readyToVerify: true,
      },
      [{ tool: "finish_card" }, { tool: "check" }],
    ),
  ];
}

// --- recorded context packs --------------------------------------------------

const AS_STORED =
  "replayed as sent: a context pack holds the rendered request, not the prompt's inputs, so it cannot be rebuilt under the current templates";

/**
 * The recorded context packs of each repository's ledger (kernel rule 17),
 * as replay cases, in step order. Only packs that recorded their tool
 * definitions can be sent as they were; the rest are counted by reason.
 * The reading follows `recordedStepRequests` (apps/harness calibrate_cmd.ts).
 */
export function recordedReplayCases(
  repos: readonly string[],
  opts: {
    modelId?: string;
    limit?: number;
    /**
     * The class catalog progressive loading reaches through `tool_search`:
     * offered in a pack that carried `tool_search`, whose recorded
     * definitions are only the tools loaded so far (worker-loop WL-M2-5).
     */
    progressiveCatalog?: readonly string[];
  } = {},
): {
  cases: ReplayCase[];
  skipped: Record<string, number>;
  /** Packs a recorded erasure deleted: named with the `ledger/erased` seq (K-N7-6). */
  gaps: { contextPackId: string; erasedBySeq: number }[];
} {
  const cases: ReplayCase[] = [];
  const skipped: Record<string, number> = {};
  const gaps: { contextPackId: string; erasedBySeq: number }[] = [];
  const skip = (why: string) => {
    skipped[why] = (skipped[why] ?? 0) + 1;
  };
  for (const repo of repos) {
    const dbPath = join(repo, ".sekhemet", "events.db");
    if (!existsSync(dbPath)) continue;
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db
      .prepare(
        `SELECT s.context_pack_id AS id FROM steps s
         WHERE s.context_pack_id IS NOT NULL ORDER BY s.card_id, s.attempt_id, s.step_index`,
      )
      .all() as unknown as { id: string }[];
    const erasures = ledgerErasures(db);
    db.close();
    const blobs = new BlobStore(repo);
    for (const row of rows) {
      if (opts.limit !== undefined && cases.length >= opts.limit) break;
      const raw = blobs.get(row.id);
      if (raw === undefined) {
        // Spine rule 2 as amended (DEC-29 O1): an erased pack is a named gap.
        const erasedBySeq = erasures.byBlob.get(row.id);
        if (erasedBySeq !== undefined) {
          gaps.push({ contextPackId: row.id, erasedBySeq });
          skip(`context pack erased by ledger/erased seq ${erasedBySeq}`);
        } else {
          skip("context pack missing");
        }
        continue;
      }
      const pack = JSON.parse(raw) as ContextPack;
      if (opts.modelId !== undefined && pack.modelId !== opts.modelId) continue;
      const schemas = pack.toolSchemas ? blobs.get(pack.toolSchemas) : undefined;
      if (schemas === undefined) {
        skip(
          pack.toolSchemas
            ? "tool definitions missing"
            : "no tool definitions recorded (an older pack)",
        );
        continue;
      }
      const tools = JSON.parse(schemas) as ToolDefinition[];
      cases.push({
        id: `${pack.cardId}#${pack.attemptId ?? "?"}:${pack.step}`,
        rendering: "as-stored",
        note: AS_STORED,
        request: {
          ...(pack.systemPrompt ? { systemPrompt: pack.systemPrompt } : {}),
          prompt: pack.prompt,
          toolArm: (pack.toolArm as ToolCallFormat | undefined) ?? "arm_a_flat",
          tools,
          ...(pack.maxTokens !== undefined ? { maxTokens: pack.maxTokens } : {}),
          ...(pack.temperature !== undefined ? { temperature: pack.temperature } : {}),
          ...(pack.reasoningBudgetTokens !== undefined
            ? { reasoningBudgetTokens: pack.reasoningBudgetTokens }
            : {}),
        },
        offered: [
          ...new Set([
            ...tools.map((t) => t.name),
            ...(tools.some((t) => t.name === "tool_search") ? (opts.progressiveCatalog ?? []) : []),
          ]),
        ],
      });
    }
  }
  return { cases, skipped, gaps };
}

// --- the screen --------------------------------------------------------------

/** Every string an argument holds, however nested. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

const normalise = (path: unknown): string =>
  typeof path === "string" ? path.replace(/^\.\//, "") : "";

function judge(c: ReplayCase, response: InferenceResponse): ReplayCaseResult {
  // A call written in the text parses whatever its name: an unknown name is a
  // tool not offered, not a reply that does not parse (review item 10).
  const fromText = () => {
    const known = parseToolCallsFromText(response.text, c.request.toolArm, c.offered);
    return known.length > 0 ? known : parseToolCallsFromText(response.text, c.request.toolArm);
  };
  const calls: ToolCall[] = response.toolCalls.length > 0 ? response.toolCalls : fromText();
  const problems: string[] = [];
  const parses = calls.length > 0;
  if (!parses) problems.push("the reply holds no tool call that parses");
  const outside = calls.filter((x) => !c.offered.includes(x.name)).map((x) => x.name);
  if (outside.length > 0) problems.push(`calls a tool not offered: ${outside.join(", ")}`);
  const echoed = [
    ...findPlaceholders(response.text),
    ...calls.flatMap((x) => strings(x.arguments).flatMap(findPlaceholders)),
  ];
  if (echoed.length > 0) problems.push(`echoes a placeholder: ${[...new Set(echoed)].join(", ")}`);
  const checks: ReplayChecks = {
    parses,
    offeredOnly: outside.length === 0,
    noPlaceholder: echoed.length === 0,
  };
  if (c.expected) {
    const first = calls[0];
    const right =
      first !== undefined &&
      c.expected.some(
        (e) =>
          e.tool === first.name &&
          (e.path === undefined || normalise(first.arguments.path) === e.path),
      );
    if (!right) {
      problems.push(
        `first call ${first ? first.name : "(none)"}; right here: ${c.expected
          .map((e) => (e.path ? `${e.tool} ${e.path}` : e.tool))
          .join(" | ")}`,
      );
    }
    checks.rightTool = right;
  }
  return {
    id: c.id,
    rendering: c.rendering,
    checks,
    passed: Object.values(checks).every(Boolean),
    calls: calls.map((x) => x.name),
    problems,
  };
}

/** Run each case for one model step and check the reply; a report, never an admission. */
export async function runStepReplay(
  cases: readonly ReplayCase[],
  model: StepReplayModel,
): Promise<StepReplayReport> {
  const results: ReplayCaseResult[] = [];
  for (const c of cases) {
    try {
      results.push(judge(c, await model.generate(c.request)));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        id: c.id,
        rendering: c.rendering,
        checks: { parses: false, offeredOnly: false, noPlaceholder: false },
        passed: false,
        calls: [],
        problems: [`the model step failed: ${message}`],
        error: message,
      });
    }
  }
  const byCheck = {
    parses: { pass: 0, fail: 0 },
    offeredOnly: { pass: 0, fail: 0 },
    noPlaceholder: { pass: 0, fail: 0 },
    rightTool: { pass: 0, fail: 0 },
  };
  for (const r of results) {
    if (r.error !== undefined) continue;
    for (const [k, v] of Object.entries(r.checks) as [keyof ReplayChecks, boolean][]) {
      byCheck[k][v ? "pass" : "fail"]++;
    }
  }
  const byState: Record<string, boolean> = {};
  for (const [i, r] of results.entries()) if (cases[i]?.expected) byState[r.id] = r.passed;
  const verdict = (rendering: ReplayCase["rendering"]) => {
    const own = results.filter((r) => r.rendering === rendering);
    return { cases: own.length, passed: own.length > 0 && own.every((r) => r.passed) };
  };
  return {
    modelId: model.modelId,
    admits: false,
    passed: results.length > 0 && results.every((r) => r.passed),
    cases: results,
    byCheck,
    modelErrors: results.filter((r) => r.error !== undefined).length,
    current: verdict("current"),
    asStoredVerdict: verdict("as-stored"),
    byState,
    asStored: results.filter((r) => r.rendering === "as-stored").length,
  };
}
