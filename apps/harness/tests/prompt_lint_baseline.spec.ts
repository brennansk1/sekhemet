import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  InMemoryEvidenceStore,
  type PromptLintBaseline,
  type PromptLintContext,
  type TurnHistoryItem,
  type WorkerPromptInput,
  buildWorkerPrompt,
  compareWithBaseline,
  extractModelFacingLiterals,
  lintPrompt,
  lowerBaseline,
} from "@sekhemet/context";
import type { GateFailure } from "@sekhemet/gates";
import type { CardRecord } from "@sekhemet/kernel";
import { TOOL_CATALOG, clampObservation, denied, planRepair, toolsForClass } from "@sekhemet/loop";
import {
  type InferenceRequest,
  MockInferenceAdapter,
  QUALIFICATION_TOOLS,
  type ToolDefinition,
  qualificationSystemPrompt,
} from "@sekhemet/models";
import { type PlannedStory, proposeSlicesWithModel, sketchWithModel } from "@sekhemet/planner";
import { beforeAll, describe, expect, it } from "vitest";
import { reflectWithManager } from "../src/learning/reflect.js";
import { reviewCard } from "../src/learning/review.js";
import type { LearningStore } from "../src/learning/store.js";
import {
  ASK_RESEARCHER_TOOL,
  PM_TOOLS,
  type PmSnapshot,
  answer,
  summarizeConversation,
} from "../src/pm/agent.js";
import type { PmMessage } from "../src/pm/types.js";

// PROMPT_STANDARD rules 35.1 and 36; context CX-M1-1 and CX-M1-12. This
// measures today's prompts and changes none of them: a rewrite is a prompt
// change and needs the suite A/B.

const ROOT = join(import.meta.dirname, "..", "..", "..");
const BASELINE = join(ROOT, "packages", "context", "prompt_lint_baseline.json");
const RECORD = process.env.SEKHEMET_RECORD_PROMPT_BASELINE === "1";
const TODAY = "2026-09-24";
const usage = { promptTokens: 1, completionTokens: 1, durationMs: 1 };

interface Template {
  name: string;
  text: string;
  ctx?: PromptLintContext;
}

const card = (stepsUsed: number): CardRecord => ({
  id: "card_ledger",
  tier: "task",
  title: "Ledger store",
  status: "in_progress",
  scopeFiles: ["src/ledger.ts"],
  stepBudget: 40,
  stepsUsed,
  createdAt: "2026-09-18T00:00:00.000Z",
  updatedAt: "2026-09-18T00:00:00.000Z",
  spec: "Store ledger entries in order and list them back.",
  acceptanceCriteria: ["append adds one entry", "list returns the entries in order"],
});

const gateFailure: GateFailure = {
  rung: "typecheck",
  exitCode: 2,
  errorExcerpt:
    "src/ledger.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
  suggestedFixFiles: ["src/ledger.ts"],
};

const turns = (n: number): TurnHistoryItem[] =>
  Array.from({ length: n }, (_, i) => ({
    turn: i + 1,
    action: i % 2 === 0 ? 'read_file(path="src/ledger.ts")' : 'grep_search(query="append")',
    result: `line ${i + 1} of the ledger module: export function append(entry) { rows.push(entry); }`,
  }));

/** Every tool a card of this class can call: its catalog set. */
const workerTools = toolsForClass("implement");
const callable = { callableTools: workerTools.map((t) => t.name) };

function workerInput(stepsUsed: number, extra: Partial<WorkerPromptInput> = {}): WorkerPromptInput {
  return {
    card: card(stepsUsed),
    tools: workerTools,
    evidenceStore: new InMemoryEvidenceStore(),
    goal: "Store ledger entries in order and list them back.",
    acceptanceCriteria: ["append adds one entry", "list returns the entries in order"],
    scopeFiles: [{ path: "src/ledger.ts", content: "export const rows = [];\n" }],
    acceptanceTests: [
      { path: "tests/ledger.spec.ts", content: 'import { rows } from "../src/ledger";\n' },
    ],
    ...extra,
  };
}

const descriptions = (tools: readonly { name: string; description: string }[]) => ({
  text: tools.map((t) => t.description).join("\n"),
  ctx: { tools },
});

const definitions = (tools: readonly ToolDefinition[]) =>
  descriptions(tools.map((t) => ({ name: t.name, description: t.description })));

/** A literal-only rendering for text assembled deep inside a tool run. */
function staticTemplate(file: string): string {
  const source = readFileSync(join(ROOT, file), "utf8");
  return extractModelFacingLiterals(file, source)
    .map((l) => l.text.replaceAll("${}", "x"))
    .join("\n");
}

/** Run `fn` against a mock model and return every request it sent. */
async function capture(
  fn: (model: MockInferenceAdapter) => Promise<unknown>,
  response = "{}",
): Promise<InferenceRequest[]> {
  const model = new MockInferenceAdapter("mock-planner", [], {
    exhaustion: "default",
    rules: [{ match: () => true, response: { text: response, toolCalls: [], usage } }],
  });
  await fn(model);
  return model.callHistory;
}

/** Whole requests (system and user text together), for contradictions that span both. */
const requests: Template[] = [];

function requestTemplates(name: string, req: InferenceRequest | undefined): Template[] {
  if (!req) throw new Error(`${name}: no request was captured`);
  requests.push({ name: `${name}.request`, text: `${req.systemPrompt ?? ""}\n\n${req.prompt}` });
  return [
    { name: `${name}.system`, text: req.systemPrompt ?? "" },
    { name: `${name}.prompt`, text: req.prompt },
  ];
}

async function renderTemplates(): Promise<Template[]> {
  const t: Template[] = [];

  // --- Worker ---
  const first = buildWorkerPrompt(workerInput(1));
  const workerRequest = (name: string, built: { systemPrompt: string; prompt: string }) =>
    requests.push({ name, text: `${built.systemPrompt}\n\n${built.prompt}`, ctx: callable });
  workerRequest("worker.request.first_step", first);
  t.push({ name: "worker.system.text_tools", text: first.systemPrompt, ctx: callable });
  t.push({ name: "worker.tail.first_step", text: first.prompt, ctx: callable });
  const native = buildWorkerPrompt(
    workerInput(1, {
      nativeToolSchemas: workerTools.map((x) => ({
        name: x.name,
        description: x.summary,
        parameters: { type: "object" },
      })),
    }),
  );
  t.push({ name: "worker.system.native_tools", text: native.systemPrompt, ctx: callable });
  const repair = buildWorkerPrompt(
    workerInput(6, { gateFailures: [gateFailure], turns: turns(5) }),
  );
  t.push({ name: "worker.tail.repair_step", text: repair.prompt, ctx: callable });
  workerRequest("worker.request.repair_step", repair);
  const ready = buildWorkerPrompt(
    workerInput(8, { readyToVerify: true, completedWork: ["wrote src/ledger.ts"] }),
  );
  t.push({ name: "worker.tail.ready_to_verify", text: ready.prompt, ctx: callable });
  workerRequest("worker.request.ready_to_verify", ready);
  const masked = buildWorkerPrompt(workerInput(12, { turns: turns(12) }));
  t.push({ name: "worker.tail.post_masking", text: masked.prompt, ctx: callable });
  workerRequest("worker.request.post_masking", masked);
  t.push({
    name: "worker.tool_descriptions",
    ...descriptions(TOOL_CATALOG.map((x) => ({ name: x.name, description: x.summary }))),
  });
  t.push({
    name: "worker.observation.denied",
    text: denied("write_file", "src/other.ts is outside the declared scope").content,
  });
  t.push({ name: "worker.observation.clamped", text: clampObservation("x".repeat(5000)) });
  t.push({
    name: "worker.observations.static_tools_ts",
    text: staticTemplate("packages/loop/src/tools.ts"),
  });
  t.push({
    name: "worker.session_notes.static_session_ts",
    text: staticTemplate("packages/loop/src/session.ts"),
  });

  // --- Planner ---
  const repairReq = await capture((m) =>
    planRepair(m, {
      card: card(6),
      stopReason: "gate_failed",
      failures: [gateFailure],
      files: [{ path: "src/ledger.ts", content: "export const rows = [];\n" }],
    }),
  );
  t.push(...requestTemplates("planner.repair_plan", repairReq[0]));
  const slices = await capture((m) =>
    proposeSlicesWithModel(m, "Store ledger entries in order and list them back.", undefined),
  );
  t.push(...requestTemplates("planner.slices", slices[0]));
  const story = {
    card: card(0),
    rationale: "The ledger is the base every later card builds on.",
    keywords: ["ledger"],
    acceptanceTests: [{ assertion: "append adds one entry" }],
  } as unknown as PlannedStory;
  const sketch = await capture((m) => sketchWithModel(m, story));
  t.push(...requestTemplates("planner.edit_sketch", sketch[0]));

  // --- Seshat ---
  const snapshot: PmSnapshot = {
    project: "chronicle",
    cards: [card(3)],
    cycles: [],
    recentRuns: ["Ledger store: passed in 3 steps (38s)"],
    worker: { model: "worker-model", record: "12 of 20 cards passed" },
    pmModel: "planner-model",
    today: TODAY,
  };
  const question: PmMessage = {
    id: "m1",
    seq: 1,
    role: "user",
    text: "How is the ledger card doing?",
    createdAt: "2026-09-24T09:00:00.000Z",
    state: "queued",
  } as PmMessage;
  const answerReq = await capture((m) => answer(m, snapshot, [], [question]), "On track.");
  t.push(...requestTemplates("seshat.answer", answerReq[0]));
  t.push({ name: "seshat.tool_descriptions", ...definitions([...PM_TOOLS, ASK_RESEARCHER_TOOL]) });
  const summary = await capture((m) => summarizeConversation(m, undefined, [question]));
  t.push(...requestTemplates("seshat.summarize", summary[0]));
  const reflection = await capture((m) =>
    reflectWithManager(m, {} as unknown as LearningStore, [
      { card: card(9), plan: "Use a number column.", firstStop: "gate_failed", retryPassed: true },
    ]),
  );
  t.push(...requestTemplates("seshat.reflection", reflection[0]));

  // --- Reviewer ---
  const review = await capture((m) =>
    reviewCard(m, {
      card: card(9),
      diff: "+export function append(entry) {}\n",
      preferences: ["Small functions"],
      rules: ["Use the built-in node:sqlite module."],
    }),
  );
  t.push(...requestTemplates("reviewer.review_card", review[0]));

  // --- Researcher ---
  // researcher.js first: the research modules import each other, and loading
  // apodex_loop.js first leaves researcher.js's tool lists unset.
  const { APODEX_TEAM_BRIEF, FINALIZE_TOOL, apodexSystemPrompt, research, researchTools } =
    await import("../src/research/researcher.js");
  const {
    EXTRACT_INFO_PROMPT,
    SUBAGENT_REPORT_FORMAT,
    coordinatorPrompt,
    researchAgentPrompt,
    subagentPrompt,
  } = await import("../src/research/apodex.js");
  const { APODEX_LOCAL_TOOLS, APODEX_WEB_TOOLS, FINALIZE_ANSWER, SUBMIT_REPORT } = await import(
    "../src/research/apodex_loop.js"
  );
  const researchReq = await capture(
    (m) => research(m, "Does DatabaseSync have run()?", { repoPath: ROOT, today: TODAY }),
    "Not settled.",
  );
  t.push(...requestTemplates("researcher.research", researchReq[0]));
  t.push({ name: "researcher.apodex.system", text: apodexSystemPrompt(TODAY) });
  t.push({ name: "researcher.agent", text: researchAgentPrompt(TODAY, APODEX_TEAM_BRIEF) });
  t.push({ name: "researcher.subagent", text: subagentPrompt(TODAY, false) });
  t.push({ name: "researcher.subagent.verifier", text: subagentPrompt(TODAY, true) });
  t.push({ name: "researcher.coordinator", text: coordinatorPrompt(TODAY, 3) });
  t.push({ name: "researcher.report_format", text: SUBAGENT_REPORT_FORMAT });
  t.push({
    name: "researcher.extract_info",
    text: EXTRACT_INFO_PROMPT("the package's licence", "Permission is granted to use and copy it."),
  });
  t.push({
    name: "researcher.tool_descriptions",
    ...definitions([
      ...researchTools(true),
      FINALIZE_TOOL,
      ...APODEX_WEB_TOOLS,
      ...APODEX_LOCAL_TOOLS,
      FINALIZE_ANSWER,
      SUBMIT_REPORT,
    ]),
  });

  // --- Model qualification (the harness's probe of a candidate model) ---
  for (const arm of ["arm_a_flat", "arm_b_json", "arm_c_sketch"] as const) {
    t.push({ name: `qualification.system.${arm}`, text: qualificationSystemPrompt(arm) });
  }
  t.push({ name: "qualification.tool_descriptions", ...definitions(QUALIFICATION_TOOLS) });
  return t;
}

describe("the prompt lint over every role's templates (PROMPT_STANDARD rule 35.1)", () => {
  let templates: Template[] = [];
  let reports: Map<string, ReturnType<typeof lintPrompt>>;

  beforeAll(async () => {
    templates = await renderTemplates();
    reports = new Map(templates.map((x) => [x.name, lintPrompt(x.text, x.ctx)]));
  });

  it("renders templates for the Worker, the Planner, Seshat, the Reviewer and the Researcher", () => {
    const roles = new Set(templates.map((x) => x.name.split(".")[0]));
    expect([...roles].sort()).toEqual([
      "planner",
      "qualification",
      "researcher",
      "reviewer",
      "seshat",
      "worker",
    ]);
    for (const x of templates) expect(x.text.trim().length, x.name).toBeGreaterThan(20);
    expect(new Set(templates.map((x) => x.name)).size).toBe(templates.length);
  });

  it("raises no style count above the recorded per-template baseline (rule 36)", () => {
    const current: PromptLintBaseline = {};
    for (const [name, r] of reports) {
      current[name] = { ...r.counts, ruleCountMethod: r.ruleCountMethod };
    }
    const recorded = existsSync(BASELINE)
      ? (JSON.parse(readFileSync(BASELINE, "utf8")) as { templates: PromptLintBaseline }).templates
      : {};
    if (RECORD) {
      const about =
        "Per-template prompt lint counts (PROMPT_STANDARD rules 35.1 and 36). A count may fall, never rise. Rerun apps/harness/tests/prompt_lint_baseline.spec.ts with SEKHEMET_RECORD_PROMPT_BASELINE=1 to record a new template or a lowered count; recording refuses a rise.";
      const templatesOut = lowerBaseline(current, recorded);
      writeFileSync(BASELINE, `${JSON.stringify({ about, templates: templatesOut }, null, 2)}\n`);
      return;
    }
    expect(compareWithBaseline(current, recorded)).toEqual([]);
  });

  // Placeholders and contradictions are defects, never baselined (rule 36).
  // Where today's text has them, the test is an expected failure until the
  // text is rewritten through the prompt change steps (rule 35), which this
  // measurement-only change does not do.
  const isWorker = (name: string) => name.startsWith("worker.");
  const hasKnownPlaceholders = (name: string) => /^(planner|researcher|qualification)\./.test(name);
  const placeholders = (keep: (name: string) => boolean) =>
    [...reports]
      .filter(([name]) => keep(name))
      .flatMap(([name, r]) => r.placeholders.map((p) => `${name}: ${p}`));
  const contradictions = (keep: (name: string) => boolean) =>
    [
      ...[...reports].filter(([name]) => keep(name)),
      ...requests
        .filter((x) => keep(x.name))
        .map((x) => [x.name, lintPrompt(x.text, x.ctx)] as const),
    ].flatMap(([name, r]) => r.contradictions.map((c) => `${name}: ${c}`));

  it("finds no placeholder in the Worker's, Seshat's or the Reviewer's templates (CX-M1-12)", () => {
    expect(placeholders((name) => !hasKnownPlaceholders(name))).toEqual([]);
  });

  it.fails(
    "finds no placeholder in the Planner's, the Researcher's or the qualification templates (CX-M1-12; expected to fail until rewritten)",
    () => {
      expect(placeholders(hasKnownPlaceholders)).toEqual([]);
    },
  );

  it("finds none of the mechanical contradictions of rule 12 outside the Worker's prompt (CX-M1-1)", () => {
    expect(contradictions((name) => !isWorker(name))).toEqual([]);
  });

  it.fails(
    "finds none of the mechanical contradictions of rule 12 in the Worker's prompt (CX-M1-1; expected to fail until the Worker text is rewritten under an A/B)",
    () => {
      expect(contradictions(isWorker)).toEqual([]);
    },
  );
});
