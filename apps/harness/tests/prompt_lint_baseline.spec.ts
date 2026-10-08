import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemoryEvidenceStore,
  PROMPT_LINT_MEASURE_VERSION,
  type PlaybookRule,
  type PromptLintBaseline,
  type PromptLintBaselineFile,
  type PromptLintContext,
  type SkillManifest,
  type ToolInterfaceSpec,
  ToolLoader,
  type TurnHistoryItem,
  type WorkerPromptInput,
  baselineEntryOf,
  baselineTotals,
  buildWorkerPrompt,
  compareWithBaseline,
  extractModelFacingLiterals,
  lintPrompt,
  nextBaselineFile,
  parseBaselineRenames,
  runSubtask,
} from "@sekhemet/context";
import { distillSkill } from "@sekhemet/eval";
import {
  DEFAULT_BUILTIN_GATES,
  DeterministicGateRunner,
  type GateFailure,
  gateCopy,
} from "@sekhemet/gates";
import type { CardRecord } from "@sekhemet/kernel";
import {
  CardExecutionSessionImpl,
  REPAIR_LADDER,
  TOOL_CATALOG,
  clampObservation,
  denied,
  planRepair,
  toolDefinition,
} from "@sekhemet/loop";
import {
  type InferenceRequest,
  type InferenceResponse,
  MockInferenceAdapter,
  QUALIFICATION_TOOLS,
  type ToolDefinition,
  qualificationSystemPrompt,
} from "@sekhemet/models";
import { type PlannedStory, proposeSlicesWithModel, sketchWithModel } from "@sekhemet/planner";
import { ProcessSandbox } from "@sekhemet/sandbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attachImage, describeAttachments } from "../src/attachments.js";
import { consolidateWithManager, reflectWithManager } from "../src/learning/reflect.js";
import { reviewCard } from "../src/learning/review.js";
import type { LearningStore } from "../src/learning/store.js";
import {
  ASK_RESEARCHER_TOOL,
  PM_TOOLS,
  type PmSnapshot,
  answer,
  summarizeConversation,
} from "../src/pm/agent.js";
import { WORKER_QUESTION_COPY } from "../src/pm/pm_copy.js";
import type { PmMessage } from "../src/pm/types.js";
import { capabilityQueries } from "../src/research/capability_queries.js";

// PROMPT_STANDARD rules 35.1 and 36; context CX-M1-1 and CX-M1-12. This
// measures today's prompts and changes none of them: a rewrite is a prompt
// change and needs the suite A/B.

const ROOT = join(import.meta.dirname, "..", "..", "..");
const BASELINE = join(ROOT, "packages", "context", "prompt_lint_baseline.json");
const RECORD = process.env.SEKHEMET_RECORD_PROMPT_BASELINE === "1";
/**
 * Set only with a change to the lint's own measurement, which raises
 * `PROMPT_LINT_MEASURE_VERSION`: it may raise recorded counts and record new
 * templates with existing violations. Its value is the reason, appended to
 * the baseline's `remeasures`. Missing templates still need a rename.
 */
const REMEASURE = process.env.SEKHEMET_PROMPT_BASELINE_REMEASURE;

/**
 * The baseline's totals, pinned so a hand edit of the file shows. A record
 * that lowers a count lowers the total here in the same change.
 */
const RECORDED_TOTALS = {
  templates: 126,
  capitalWords: 581,
  negations: 427,
  longToolDescriptions: 5,
};
const TODAY = "2026-09-24";
const usage = { promptTokens: 1, completionTokens: 1, durationMs: 1 };

/**
 * Placeholders and contradictions are defects, never baselined (rule 36).
 * These are today's, found by the renders below. Each entry is removed when
 * the text is rewritten through the prompt change steps (rule 35); the test
 * fails on an addition and on an entry that no longer occurs.
 */
const KNOWN_PLACEHOLDERS: string[] = [
  "planner.repair_plan.prompt: [typecheck]",
  "seshat.answer.r2.prompt: [grounded, confidence 0.80]",
  "researcher.research.prompt: [n]",
  "researcher.research.r1.prompt: [n]",
  "researcher.research.r2.prompt: [n]",
  "researcher.research_native.prompt: [n]",
  "researcher.research_native.r1.prompt: [n]",
  "researcher.research_native.r2.prompt: [n]",
  "researcher.research_native.r2.prompt: [n]",
  "researcher.investigate.prompt: [n]",
  "researcher.investigate.r1.prompt: [n]",
  "researcher.investigate.r2.prompt: [n]",
  "researcher.investigate.r3.prompt: [n]",
  "researcher.investigate.r4.prompt: [n]",
  "researcher.investigate.r6.prompt: [n]",
  "researcher.investigate.r7.prompt: [n]",
  "researcher.investigate.r8.prompt: [n]",
  "researcher.apodex_team.r3.system: [what you were asked, and how you approached it]",
  "researcher.apodex_team.r3.system: [one line per piece of support]",
  // The sub-agent's second dispatch (an open sub-question sent again,
  // DS-N4-2) carries the same system prompt as its first.
  "researcher.apodex_team.r4.system: [what you were asked, and how you approached it]",
  "researcher.apodex_team.r4.system: [one line per piece of support]",
  'researcher.apodex_team.r5.prompt: <report agent="docs">',
  "researcher.apodex_team.r5.prompt: </report>",
  "researcher.agent: <untrusted>",
  "researcher.agent: [context compacted]",
  "researcher.subagent: [what you were asked, and how you approached it]",
  "researcher.subagent: [one line per piece of support]",
  "researcher.subagent.verifier: [what you were asked, and how you approached it]",
  "researcher.subagent.verifier: [one line per piece of support]",
  "researcher.report_format: [what you were asked, and how you approached it]",
  "researcher.report_format: [one line per piece of support]",
  "qualification.system.arm_a_flat: <tool>",
  "qualification.system.arm_b_json: <tool>",
  "qualification.system.arm_c_sketch: <tool>",
];
const KNOWN_CONTRADICTIONS: string[] = [];

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

// As the tsc parser gives it (packages/gates/src/parsers.ts), remedy included.
const gateFailure: GateFailure = {
  rung: "typecheck",
  gate: "typecheck",
  layer: "static",
  exitCode: 2,
  errorExcerpt:
    "src/ledger.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
  suggestedFixFiles: ["src/ledger.ts"],
  location: { file: "src/ledger.ts", line: 3, column: 7 },
  expected: "type-correct program",
  actual: "TS2322: Type 'string' is not assignable to type 'number'.",
  minimalRepro: "pnpm typecheck",
  suggestedAction: gateCopy.resolveCode("TS2322", "src/ledger.ts", "3"),
};

const turns = (n: number): TurnHistoryItem[] =>
  Array.from({ length: n }, (_, i) => ({
    turn: i + 1,
    action: i % 2 === 0 ? 'read_file(path="src/ledger.ts")' : 'grep_search(query="append")',
    result: `line ${i + 1} of the ledger module: export function append(entry) { rows.push(entry); }`,
  }));

/** What the card runner offers `note`'s `gate` for a project with the usual gates. */
const GATES = [
  ...new Set(["typecheck", "test", "lint", ...DEFAULT_BUILTIN_GATES, "bounds", "integrity"]),
];

/**
 * Every tool a card of this class can call, as a session gives it: the class
 * set with note's gate enum (GT-M6-5). The lint sees what a session sends.
 */
function sessionTools(scriptCapable = false, progressiveTools = false): ToolInterfaceSpec[] {
  const worktreePath = mkdtempSync(join(tmpdir(), "sekhemet-lint-session-"));
  try {
    return new CardExecutionSessionImpl({
      cardId: "card_ledger",
      card: card(0),
      stepBudget: 40,
      worktreePath,
      scopeFiles: ["src/ledger.ts"],
      modelAdapter: new MockInferenceAdapter("mock", []),
      gateRunner: new DeterministicGateRunner(new ProcessSandbox()),
      suspectableGates: GATES,
      scriptCapable,
      progressiveTools,
    }).getToolSpecs();
  } finally {
    rmSync(worktreePath, { recursive: true, force: true });
  }
}
const workerTools = sessionTools();
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

const descriptions = (
  tools: readonly {
    name: string;
    description: string;
    parameters?: readonly { name: string; description: string }[];
  }[],
) => ({
  text: tools
    .flatMap((t) => [t.description, ...(t.parameters ?? []).map((p) => p.description)])
    .join("\n"),
  ctx: { tools },
});

/** A JSON-schema tool definition's parameter descriptions. */
function schemaParameters(parameters: unknown): { name: string; description: string }[] {
  const props = (parameters as { properties?: Record<string, { description?: unknown }> })
    ?.properties;
  return Object.entries(props ?? {}).flatMap(([name, p]) =>
    typeof p?.description === "string" ? [{ name, description: p.description }] : [],
  );
}

const definitions = (tools: readonly ToolDefinition[]) =>
  descriptions(
    tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: schemaParameters(t.parameters),
    })),
  );

/**
 * A literal-only rendering for text assembled deep inside a tool run or an
 * inline closure. `from` starts it at the literal with that prefix and keeps
 * that literal and the next, as a request's system text and prompt.
 */
function staticTemplate(file: string, from?: string): string {
  const source = readFileSync(join(ROOT, file), "utf8");
  const literals = extractModelFacingLiterals(file, source);
  const at = from === undefined ? 0 : literals.findIndex((l) => l.text.startsWith(from));
  if (at === -1) throw new Error(`${file}: no model-facing literal starts "${from}"`);
  return (from === undefined ? literals : literals.slice(at, at + 2))
    .map((l) => l.text.replaceAll("${}", "x"))
    .join("\n");
}

type Reply = string | Partial<InferenceResponse>;

/**
 * Run `fn` against a mock model and return every request it sent. `respond`
 * scripts each reply from the request and its index; by default the model
 * answers `{}`.
 */
async function capture(
  fn: (model: MockInferenceAdapter) => Promise<unknown>,
  respond: Reply | ((req: InferenceRequest, n: number) => Reply) = "{}",
  setup: (model: MockInferenceAdapter) => void = () => {},
): Promise<InferenceRequest[]> {
  let n = 0;
  const model = new MockInferenceAdapter("mock-planner", [], {
    exhaustion: "default",
    rules: [
      {
        match: () => true,
        response: (req) => {
          const r = typeof respond === "function" ? respond(req, n++) : respond;
          return typeof r === "string"
            ? { text: r, toolCalls: [], usage }
            : { text: "", toolCalls: [], usage, ...r };
        },
      },
    ],
  });
  setup(model);
  await fn(model);
  return model.callHistory;
}

const call = (name: string, args: Record<string, unknown> = {}, id = `c_${name}`) => ({
  toolCalls: [{ id, name, arguments: args }],
});

/** Whole requests (system and user text together), for contradictions that span both. */
const requests: Template[] = [];

/** The user side of a request: its prompt and every message after it. */
const userSide = (req: InferenceRequest) =>
  [req.prompt, ...(req.messages ?? []).map((m) => m.content)].filter((t) => t.trim()).join("\n\n");

/**
 * Every captured request of one flow, as templates. The first request keeps
 * the flow's name; each later one carries its index (`.r1`, `.r2`, ...), so
 * a flow's later rounds are linted too. A request that offers tools is
 * linted against them (`callableTools`).
 */
function requestTemplates(
  name: string,
  reqs: readonly InferenceRequest[],
  /** The flow's tools, when they are not all on each request (the text-tool research flow). */
  callableTools?: readonly string[],
): Template[] {
  if (reqs.length === 0) throw new Error(`${name}: no request was captured`);
  return reqs.flatMap((req, i) => {
    const base = i === 0 ? name : `${name}.r${i}`;
    const names = callableTools ?? req.tools?.map((t) => t.name);
    const ctx: PromptLintContext | undefined = names ? { callableTools: names } : undefined;
    const system = req.systemPrompt ?? "";
    const user = userSide(req);
    requests.push({
      name: `${base}.request`,
      text: `${system}\n\n${user}`,
      ...(ctx ? { ctx } : {}),
    });
    return [
      ...(system.trim() ? [{ name: `${base}.system`, text: system, ...(ctx ? { ctx } : {}) }] : []),
      ...(user.trim() ? [{ name: `${base}.prompt`, text: user, ...(ctx ? { ctx } : {}) }] : []),
    ];
  });
}

/** The core tools progressive loading starts with (`PROGRESSIVE_CORE_TOOLS`, session.ts). */
const PROGRESSIVE_CORE = ["read_file", "edit", "write_file", "check", "finish_card"];

const playbookRules: PlaybookRule[] = [
  { id: "r1", pattern: "ledger", instruction: "Use the built-in node:sqlite module." },
  {
    id: "r2",
    pattern: "TS2322",
    instruction: "Convert the value before storing it.",
    errorPattern: "TS2322",
  },
];

const skills: SkillManifest[] = [
  {
    name: "sqlite-store",
    description: "How this repository stores rows in node:sqlite.",
    triggers: ["ledger"],
    content: "Open the database once and prepare statements up front.",
    disclosure: "full",
  },
];

let tmp: string | undefined;

async function renderTemplates(): Promise<Template[]> {
  const t: Template[] = [];

  // --- Worker ---
  const workerRequest = (
    name: string,
    built: { systemPrompt: string; prompt: string },
    ctx: PromptLintContext = callable,
  ) => requests.push({ name, text: `${built.systemPrompt}\n\n${built.prompt}`, ctx });
  const first = buildWorkerPrompt(workerInput(1));
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

  // Each rung of the repair ladder, as its directive reaches the tail.
  for (const rung of REPAIR_LADDER) {
    const built = buildWorkerPrompt(
      workerInput(9, {
        gateFailures: [gateFailure],
        turns: turns(3),
        rungDirective: rung.directive,
      }),
    );
    t.push({ name: `worker.tail.rung.${rung.rung}`, text: built.prompt, ctx: callable });
    workerRequest(`worker.request.rung.${rung.rung}`, built);
  }

  // Every optional block: lessons, card and error rules, skills, the team
  // note, the repair plan, the dossier and the repo map.
  const blocks = buildWorkerPrompt(
    workerInput(7, {
      gateFailures: [gateFailure],
      turns: turns(4),
      lessons: [
        "still failing after 2 edits to src/ledger.ts: TS2322. That approach is not working: change strategy, do not repeat it.",
        "fixed: TS2304 cannot find name rows (do not reintroduce)",
      ],
      rules: playbookRules,
      skills,
      teamNote: "Seshat is available now; ask a question with ask(question).",
      repairPlan: "Root cause: append stores a string.\n1. Convert the amount to a number.",
      dossier: [{ label: "From the team (this card)", text: "Keep the rows array exported." }],
      repoMap: "src/ledger.ts: rows, append(entry), list()",
    }),
  );
  t.push({ name: "worker.system.all_blocks", text: blocks.systemPrompt, ctx: callable });
  t.push({ name: "worker.tail.all_blocks", text: blocks.prompt, ctx: callable });
  workerRequest("worker.request.all_blocks", blocks);

  // Criteria that arrive already numbered, as the frozen fixtures write them.
  const numbered = buildWorkerPrompt(
    workerInput(1, {
      acceptanceCriteria: ["1. append adds one entry", "2. list returns the entries in order"],
    }),
  );
  t.push({ name: "worker.tail.numbered_criteria", text: numbered.prompt, ctx: callable });
  workerRequest("worker.request.numbered_criteria", numbered);

  // Progressive loading (C19): the loaded subset is shown, the class catalog
  // stays callable through tool_search. The catalog is the progressive arm's,
  // as a session with progressiveTools builds it (worker-loop WL-M2-3).
  const progressiveTools = sessionTools(false, true);
  const loader = new ToolLoader(progressiveTools, PROGRESSIVE_CORE);
  const coreSpecs = loader.visibleSpecs();
  loader.handle("grep_search");
  const loadedSince = loader
    .visibleSpecs()
    .filter((s) => !coreSpecs.some((c) => c.name === s.name));
  const progressiveCtx = {
    callableTools: [...new Set([...progressiveTools.map((x) => x.name), "tool_search"])],
  };
  const progressive = buildWorkerPrompt(
    workerInput(3, {
      tools: coreSpecs,
      toolIndex: progressiveTools,
      loadedTools: loadedSince,
      turns: turns(2),
    }),
  );
  t.push({
    name: "worker.system.progressive",
    text: progressive.systemPrompt,
    ctx: progressiveCtx,
  });
  t.push({ name: "worker.tail.progressive", text: progressive.prompt, ctx: progressiveCtx });
  workerRequest("worker.request.progressive", progressive, progressiveCtx);
  const progressiveNative = buildWorkerPrompt(
    workerInput(3, {
      tools: coreSpecs,
      toolIndex: progressiveTools,
      loadedTools: loadedSince,
      nativeToolSchemas: loader.visibleSchemas(
        progressiveTools.map((x) => ({
          name: x.name,
          description: x.summary,
          parameters: { type: "object" },
        })),
      ),
      turns: turns(2),
    }),
  );
  t.push({
    name: "worker.system.progressive_native",
    text: progressiveNative.systemPrompt,
    ctx: progressiveCtx,
  });
  workerRequest("worker.request.progressive_native", progressiveNative, progressiveCtx);

  // A tool set without recall, after masking has left observation pointers.
  const noRecall = workerTools.filter((x) => x.name !== "recall");
  const noRecallCtx = { callableTools: noRecall.map((x) => x.name) };
  const withoutRecall = buildWorkerPrompt(workerInput(12, { tools: noRecall, turns: turns(12) }));
  t.push({ name: "worker.tail.without_recall", text: withoutRecall.prompt, ctx: noRecallCtx });
  workerRequest("worker.request.without_recall", withoutRecall, noRecallCtx);

  // Every catalog tool's description as a session sends it: the one builder
  // (tool_schema.ts), note's gate enum included; script-capable, so
  // run_script is described too, and under progressive loading, whose
  // catalog holds every tool (the fixed set holds twelve, worker-loop WL-M2-3).
  const described = sessionTools(true, true);
  expect(described.map((x) => x.name).sort()).toEqual(TOOL_CATALOG.map((x) => x.name).sort());
  t.push({ name: "worker.tool_descriptions", ...definitions(described.map(toolDefinition)) });
  t.push({
    name: "worker.observation.denied",
    text: denied("write_file", "src/other.ts is outside the declared scope").content,
  });
  t.push({ name: "worker.observation.clamped", text: clampObservation("x".repeat(5000)) });
  // tool_search's replies: a tool found, files asked for, symbols asked for, nothing.
  const search = new ToolLoader(workerTools, PROGRESSIVE_CORE);
  t.push({ name: "worker.observation.tool_search.found", text: search.handle("grep_search").text });
  t.push({
    name: "worker.observation.tool_search.files",
    text: search.handle("src/ledger.js").text,
  });
  t.push({
    name: "worker.observation.tool_search.symbols",
    text: search.handle("LedgerEntry").text,
  });
  t.push({
    name: "worker.observation.tool_search.none",
    text: search.handle("teleport quickly").text,
  });
  t.push({
    name: "worker.observations.static_tools_ts",
    text: staticTemplate("packages/loop/src/tools.ts"),
  });
  t.push({
    name: "worker.session_notes.static_session_ts",
    text: staticTemplate("packages/loop/src/session.ts"),
  });
  // The subtask's child model (C16), with and without tools.
  const subtask = await capture(
    (m) =>
      runSubtask({
        adapter: m,
        question: "Which file defines append?",
        context: "src/ledger.ts exports rows.",
        tools: [
          {
            name: "grep_search",
            description: "Search files.",
            parameters: { type: "object" },
          },
        ],
        executeTool: async () => "src/ledger.ts:3: export function append",
        maxSteps: 2,
      }),
    (_req, n) => (n === 0 ? call("grep_search", { query: "append" }) : "ANSWER: src/ledger.ts"),
  );
  t.push(...requestTemplates("worker.subtask", subtask));

  // --- Planner ---
  const repairReq = await capture((m) =>
    planRepair(m, {
      card: card(6),
      stopReason: "gate_failed",
      failures: [gateFailure],
      files: [{ path: "src/ledger.ts", content: "export const rows = [];\n" }],
    }),
  );
  t.push(...requestTemplates("planner.repair_plan", repairReq));
  const slices = await capture((m) =>
    proposeSlicesWithModel(m, "Store ledger entries in order and list them back.", undefined),
  );
  t.push(...requestTemplates("planner.slices", slices));
  const story = {
    card: card(0),
    rationale: "The ledger is the base every later card builds on.",
    keywords: ["ledger"],
    acceptanceTests: [{ assertion: "append adds one entry" }],
  } as unknown as PlannedStory;
  const sketch = await capture((m) => sketchWithModel(m, story));
  t.push(...requestTemplates("planner.edit_sketch", sketch));
  // Design-stage §2.5 item 1 (compliance C3): the survey's capability queries.
  const reuseQueries = await capture(
    (m) => capabilityQueries("sends invoices to customers by email", { planner: m }),
    '{"queries": ["email sending"]}',
  );
  t.push(...requestTemplates("planner.reuse_queries", reuseQueries));

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
  // Two lookup rounds: a library search, then a question for the Researcher.
  const answerReq = await capture(
    (m) =>
      answer(
        m,
        snapshot,
        [],
        [question],
        undefined,
        async () => [],
        // Only the fields answer() reads.
        async () =>
          ({
            answer: "run() returns changes [1].",
            sources: ["node docs"],
            grounded: true,
            confidence: 0.8,
          }) as never,
      ),
    (_req, n) =>
      n === 0
        ? call("find_library", { query: "sqlite" })
        : n === 1
          ? call("ask_researcher", { question: "Does run() return changes?" })
          : "On track.",
  );
  t.push(...requestTemplates("seshat.answer", answerReq));
  t.push({ name: "seshat.tool_descriptions", ...definitions([...PM_TOOLS, ASK_RESEARCHER_TOOL]) });
  const summary = await capture((m) => summarizeConversation(m, undefined, [question]));
  t.push(...requestTemplates("seshat.summarize", summary));
  const reflection = await capture((m) =>
    reflectWithManager(m, {} as unknown as LearningStore, [
      { card: card(9), plan: "Use a number column.", firstStop: "gate_failed", retryPassed: true },
    ]),
  );
  t.push(...requestTemplates("seshat.reflection", reflection));
  const at = "2026-09-20T00:00:00.000Z";
  const learning = {
    rules: async () => [
      { id: "old", text: "Store amounts as numbers.", status: "active", evidence: [] },
      {
        id: "new",
        text: "Store amounts as integers of cents.",
        status: "candidate",
        related: ["old"],
        evidence: [],
      },
    ],
    profile: async () => [
      {
        id: "p1",
        statement: "Prefer small functions in the ledger module",
        category: "style",
        status: "active",
        evidence: [{ note: "said so", at }],
      },
      {
        id: "p2",
        statement: "Prefer large functions in the ledger module",
        category: "style",
        status: "active",
        evidence: [{ note: "said so", at: "2026-09-22T00:00:00.000Z" }],
      },
    ],
    update: async () => undefined,
    updateProfile: async () => undefined,
  } as unknown as LearningStore;
  const consolidate = await capture((m) => consolidateWithManager(m, learning));
  t.push(...requestTemplates("seshat.consolidate", consolidate));
  // Seshat answering a Worker's question inline (askTeam; moved from index.ts
  // to the queue's registry command, commands/queue.ts, with `queue` in C5,
  // and its words into the PM copy module): the same text the static
  // template read, system then prompt, each placeholder "x".
  t.push({
    name: "seshat.ask_team.static_index_ts",
    text: `${WORKER_QUESTION_COPY.system}\n${WORKER_QUESTION_COPY.prompt("x", "x", "x", "x")}`,
  });

  // --- Reviewer ---
  // review-git P8: one request over a line-numbered diff, with the staged
  // cases per criterion, the checks and the Worker's recorded assumptions.
  const review = await capture((m) =>
    reviewCard(m, {
      card: { ...card(9), criterionIds: ["AC-1", "AC-2"] },
      diff: [
        "diff --git a/src/ledger.ts b/src/ledger.ts",
        "--- a/src/ledger.ts",
        "+++ b/src/ledger.ts",
        "@@ -1,1 +1,2 @@",
        " const rows = [];",
        "+export function append(entry) { rows.push(entry); }",
        "",
      ].join("\n"),
      stagedTests: [
        { path: "tests/ledger.spec.ts", cases: [{ name: "appends", criterionId: "AC-1" }] },
      ],
      checks: [{ gate: "test", passed: true }],
      assumptions: ["Assumed: entries are strings"],
      preferences: ["Small functions"],
      rules: ["Use the built-in node:sqlite module."],
    }),
  );
  t.push(...requestTemplates("reviewer.review_card", review));

  // --- Researcher ---
  const {
    APODEX_TEAM_BRIEF,
    FINALIZE_TOOL,
    apodexSystemPrompt,
    investigate,
    research,
    researchTools,
  } = await import("../src/research/researcher.js");
  const {
    EXTRACT_INFO_PROMPT,
    SUBAGENT_REPORT_FORMAT,
    coordinatorPrompt,
    researchAgentPrompt,
    subagentPrompt,
  } = await import("../src/research/apodex.js");
  const {
    APODEX_LOCAL_TOOLS,
    APODEX_WEB_TOOLS,
    EvidenceLedger,
    FINALIZE_ANSWER,
    SUBMIT_REPORT,
    apodexLoop,
    apodexTeam,
  } = await import("../src/research/apodex_loop.js");
  const deps = { repoPath: ROOT, today: TODAY, libraries: async () => [] };
  // The flat transcript: a lookup, then later rounds up to the last.
  const researchReq = await capture(
    (m) => research(m, "Does DatabaseSync have run()?", deps),
    (_req, n) => (n < 2 ? call("find_library", { query: `sqlite ${n}` }) : "Not settled."),
  );
  t.push(
    ...requestTemplates(
      "researcher.research",
      researchReq,
      researchTools(false).map((x) => x.name),
    ),
  );
  // The native-tools branch: an uncited answer is sent back once, then the last round.
  const nativeReq = await capture(
    (m) => research(m, "Does DatabaseSync have run()?", deps),
    (_req, n) => (n === 0 ? call("find_library", { query: "sqlite" }) : "DatabaseSync has run()."),
    (m) => Object.defineProperty(m, "nativeTools", { value: true }),
  );
  t.push(...requestTemplates("researcher.research_native", nativeReq));
  // Deep research: the plan, each sub-run, the query rewrite and the merge.
  const investigateReq = await capture(
    (m) => investigate(m, "Is node:sqlite ready for the ledger?", deps, { maxRounds: 2 }),
    (req) => {
      const text = userSide(req);
      if (/Break this into/.test(text)) {
        return '["Does DatabaseSync have run()?", "Is node:sqlite stable in Node 24?"]';
      }
      if (/better-targeted research question/.test(text)) {
        return '["Is the node:sqlite module marked stable?"]';
      }
      if (/Merge the findings/.test(text)) return "Merged answer [1].";
      if (/EVIDENCE \(round/.test(text)) return "run() exists [1].";
      return call("find_library", { query: "node sqlite" });
    },
  );
  t.push(...requestTemplates("researcher.investigate", investigateReq));
  // Apodex's solo loop: repeated calls, a text-only turn, a rejected finalize, the last turn.
  const solo = await capture(
    (m) =>
      apodexLoop(m, "Does DatabaseSync have run()?", deps, {
        role: "solo",
        system: apodexSystemPrompt(TODAY),
        maxTurns: 6,
        budgetChars: 40_000,
        ledger: new EvidenceLedger(),
      }),
    (_req, n) =>
      n < 3
        ? call("find_library", { query: "sqlite" }, `c${n}`)
        : n === 3
          ? "I think it does."
          : n === 4
            ? call("finalize_answer", { content: "Yes [1]." })
            : "Yes.",
  );
  t.push(...requestTemplates("researcher.apodex_loop", solo));
  // Apodex's team: create, assign, collect (one sub-agent run), then answer.
  const team = await capture(
    (m) =>
      apodexTeam(m, "Does DatabaseSync have run()?", deps, {
        today: TODAY,
        coordinatorTurns: 4,
        subTurns: 2,
        budgetChars: 40_000,
        brief: APODEX_TEAM_BRIEF,
      }),
    (req, n) => {
      if (req.systemPrompt?.startsWith(coordinatorPrompt(TODAY, 4).slice(0, 40))) {
        if (n === 0) {
          return call("create_subagent", {
            agents: [{ name: "docs", system_prompt: "Read the Node docs." }],
          });
        }
        if (n === 1) {
          return call("assign_task", {
            tasks: [
              { agent: "docs", prompt: "Check whether DatabaseSync has run() in the Node docs." },
            ],
          });
        }
        if (n === 2) return call("collect_reports");
        return "run() exists [1].\n\nReferences\n[1] https://nodejs.org/api/sqlite.html";
      }
      return call("submit_report", { content: "Findings: run() exists." });
    },
  );
  t.push(...requestTemplates("researcher.apodex_team", team));
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

  // --- Vision: describing a card's attached image ---
  tmp = mkdtempSync(join(tmpdir(), "sekhemet-lint-"));
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const cardStub = {
    getCard: async () => card(0),
    recordEvent: async () => undefined,
    recordDossierEntry: async () => undefined,
    cardEvents: async () => [],
  };
  await attachImage(tmp, cardStub as never, "card_ledger", { name: "mock.png", bytes: png });
  const vision = await capture((m) =>
    describeAttachments(tmp as string, cardStub as never, card(0), m),
  );
  t.push(...requestTemplates("vision.describe_attachments", vision));

  // --- Learning: a skill distilled from passing trajectories ---
  const trajectory = (id: string) => ({
    cardId: id,
    title: "Add ledger append",
    cardClass: "implement",
    passed: true,
    steps: [
      { action: "read_file(src/ledger.ts)", result: "export const rows = [];" },
      { action: "edit(src/ledger.ts)", result: "ok" },
    ],
  });
  const distill = await capture(
    (m) => distillSkill([trajectory("a"), trajectory("b"), trajectory("c")], { adapter: m }),
    "1. Read the file.\n2. Edit it.",
  );
  t.push(...requestTemplates("learning.distill_skill", distill));

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
  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("renders templates for every role that sends a model a prompt", () => {
    const roles = new Set(templates.map((x) => x.name.split(".")[0]));
    expect([...roles].sort()).toEqual([
      "learning",
      "planner",
      "qualification",
      "researcher",
      "reviewer",
      "seshat",
      "vision",
      "worker",
    ]);
    for (const x of templates) expect(x.text.trim().length, x.name).toBeGreaterThan(20);
    expect(new Set(templates.map((x) => x.name)).size).toBe(templates.length);
  });

  it("renders the later rounds of every multi-request flow (CX-M1-1)", () => {
    const names = new Set(templates.map((x) => x.name));
    for (const name of [
      "worker.subtask.r1.prompt",
      "seshat.answer.r2.prompt",
      "seshat.consolidate.r1.prompt",
      "researcher.research.r2.prompt",
      "researcher.research_native.r2.prompt",
      "researcher.apodex_loop.r5.prompt",
      "researcher.apodex_team.r3.prompt",
    ]) {
      expect(names.has(name), name).toBe(true);
    }
    const investigateText = templates
      .filter((x) => x.name.startsWith("researcher.investigate"))
      .map((x) => x.text)
      .join("\n");
    for (const step of [
      "Break this into",
      "better-targeted research question",
      "Merge the findings",
    ]) {
      expect(investigateText, step).toContain(step);
    }
  });

  it("raises no style count above the recorded per-template baseline (rule 36)", () => {
    const current: PromptLintBaseline = {};
    for (const [name, r] of reports) current[name] = baselineEntryOf(r);
    // Recording never creates the file: a missing baseline would accept everything.
    expect(existsSync(BASELINE), `${BASELINE} is missing; restore it from git`).toBe(true);
    const file = JSON.parse(readFileSync(BASELINE, "utf8")) as PromptLintBaselineFile;
    if (RECORD) {
      const about =
        "Per-template prompt lint counts (PROMPT_STANDARD rules 35.1 and 36). A count may fall, never rise; a legacy template's rule count is not measured (null). Rerun apps/harness/tests/prompt_lint_baseline.spec.ts with SEKHEMET_RECORD_PROMPT_BASELINE=1 to lower a count or record a new template; recording refuses a rise, a dropped template without SEKHEMET_PROMPT_BASELINE_RENAME=old:new, and a new template with capital emphasis or a long tool description. When a change to the lint raises PROMPT_LINT_MEASURE_VERSION, re-record with SEKHEMET_PROMPT_BASELINE_REMEASURE=<reason> as well: only then may counts rise, and the reason, the version and the date are appended to remeasures, which every later record carries forward. The totals are pinned in the test.";
      const next = nextBaselineFile(file, current, {
        about,
        today: new Date().toISOString().slice(0, 10),
        renames: parseBaselineRenames(process.env.SEKHEMET_PROMPT_BASELINE_RENAME),
        remeasure: REMEASURE,
      });
      writeFileSync(BASELINE, `${JSON.stringify(next, null, 2)}\n`);
      return;
    }
    expect(
      file.measureVersion,
      "the lint's measurement changed: re-record with SEKHEMET_PROMPT_BASELINE_REMEASURE=<reason>",
    ).toBe(PROMPT_LINT_MEASURE_VERSION);
    expect(compareWithBaseline(current, file.templates)).toEqual([]);
    expect(
      baselineTotals(file.templates),
      "the baseline's totals differ from RECORDED_TOTALS: change them together",
    ).toEqual(RECORDED_TOTALS);
  });

  const placeholders = () =>
    [...reports].flatMap(([name, r]) => r.placeholders.map((p) => `${name}: ${p}`));
  const contradictions = () =>
    [...reports, ...requests.map((x) => [x.name, lintPrompt(x.text, x.ctx)] as const)].flatMap(
      ([name, r]) => r.contradictions.map((c) => `${name}: ${c}`),
    );

  it("finds exactly the known placeholders, until each is rewritten (CX-M1-12)", () => {
    expect(placeholders()).toEqual(KNOWN_PLACEHOLDERS);
  });

  it("finds exactly the known contradictions of rule 12, until each is rewritten (CX-M1-1)", () => {
    expect(contradictions()).toEqual(KNOWN_CONTRADICTIONS);
  });

  it("finds no empty rule section beside directives elsewhere (rule 11)", () => {
    expect(
      [...reports].flatMap(([name, r]) => r.ruleViolations.map((v) => `${name}: ${v}`)),
    ).toEqual([]);
  });
});
