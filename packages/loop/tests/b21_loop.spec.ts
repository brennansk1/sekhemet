import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { workerCopy } from "@sekhemet/context";
import { DeterministicGateRunner } from "@sekhemet/gates";
import { CARD_STOP_REASONS, LifecycleHookEngine } from "@sekhemet/kernel";
import {
  type InferenceResponse,
  MockInferenceAdapter,
  REASONING_BUDGET_TOKENS,
} from "@sekhemet/models";
import { ProcessSandbox } from "@sekhemet/sandbox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { phaseOf } from "../src/phase.js";
import { CardExecutionSessionImpl } from "../src/session.js";
import { CLASS_TOOLS, TOOL_CATALOG, toolsForClass } from "../src/tool_catalog.js";
import { toolDefinition } from "../src/tool_schema.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** Source text without comments, so a reason named in prose is not a list. */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

describe("phaseOf (WL-T3-1)", () => {
  const base = { tools: [] as string[], filesWrittenBefore: 0, failedCheckStanding: false };
  it("is find before anything is written", () => {
    expect(phaseOf({ ...base, tools: ["read_file", "grep_search"] })).toBe("find");
    expect(phaseOf(base)).toBe("find");
  });
  it("is edit once the step writes, or once anything has been written", () => {
    expect(phaseOf({ ...base, tools: ["read_file", "edit"] })).toBe("edit");
    expect(phaseOf({ ...base, tools: ["read_file"], filesWrittenBefore: 2 })).toBe("edit");
  });
  it("is verify when the step checks or finishes", () => {
    expect(phaseOf({ ...base, tools: ["check"], filesWrittenBefore: 1 })).toBe("verify");
    expect(phaseOf({ ...base, tools: ["edit", "finish_card"], failedCheckStanding: true })).toBe(
      "verify",
    );
    expect(phaseOf({ ...base, tools: ["edit"], filesWrittenBefore: 1, verified: true })).toBe(
      "verify",
    );
  });
  it("is repair while a failed check stands", () => {
    expect(
      phaseOf({ ...base, tools: ["read_file"], filesWrittenBefore: 1, failedCheckStanding: true }),
    ).toBe("repair");
    expect(phaseOf({ ...base, tools: ["edit"], failedCheckStanding: true })).toBe("repair");
  });
});

describe("no hand-kept stop-reason sets (WL-T3-2)", () => {
  const files = [
    ...sources(join(ROOT, "packages/loop/src")),
    ...sources(join(ROOT, "apps/harness/src")),
  ];
  const reasons = CARD_STOP_REASONS.join("|");
  const list = new RegExp(`"(${reasons})"\\s*,\\s*"(${reasons})"`);
  const chain = new RegExp(
    `[sS]topReason\\s*[!=]==\\s*"(${reasons})"\\s*(&&|\\|\\|)\\s*[\\w.?]*[sS]topReason\\s*[!=]==`,
  );
  it("finds no set, list or comparison chain of stop reasons in packages/loop or apps/harness", () => {
    expect(files.length).toBeGreaterThan(10);
    const offenders: string[] = [];
    for (const f of files) {
      const text = code(f);
      if (/Set<\s*(Execution|Card)StopReason\s*>/.test(text)) offenders.push(`${f}: Set`);
      if (list.test(text)) offenders.push(`${f}: list ${text.match(list)?.[0]}`);
      if (chain.test(text)) offenders.push(`${f}: chain ${text.match(chain)?.[0]}`);
    }
    expect(offenders.map((o) => relative(ROOT, o))).toEqual([]);
  });
});

describe("one default step budget (WL-T3-11)", () => {
  it("finds no literal default step or seconds budget outside the kernel constant", () => {
    const roots = readdirSync(join(ROOT, "packages")).map((p) => join(ROOT, "packages", p, "src"));
    const files = [...roots, join(ROOT, "apps/harness/src")]
      .filter((d) => {
        try {
          return statSync(d).isDirectory();
        } catch {
          return false;
        }
      })
      .flatMap(sources);
    const patterns = [
      /\bstep_?[bB]udget\s*(\?\?|===)\s*\d/,
      /\bsecondsBudget\s*\?\?\s*\d/,
      /\b(DEFAULT_STEP_BUDGET|defaultStepBudget|default_step_budget)\s*[:=]\s*\d/,
      /default\w*[^\n]*\bstepBudget:\s*\d/i,
      /\bstepBudget:\s*\d+,\s*maxFailedChecks/,
      /step_budget INTEGER[^\n]*DEFAULT \d/,
      /stepBudget as number\)\s*\?\?\s*\d/,
    ];
    const offenders: string[] = [];
    for (const f of files) {
      if (f.endsWith("kernel/src/stop_reasons.ts")) continue;
      const text = code(f);
      for (const p of patterns) {
        const m = text.match(p);
        if (m) offenders.push(`${relative(ROOT, f)}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("explicit tool sets per class (WL-M2-1, WL-M2-4)", () => {
  it("WL-M2-1: every card class has an explicit CLASS_TOOLS entry", () => {
    for (const cls of ["spike", "interface", "implement", "data", "rule", "review", "research"]) {
      expect(CLASS_TOOLS[cls as keyof typeof CLASS_TOOLS], cls).toBeDefined();
      for (const name of CLASS_TOOLS[cls as keyof typeof CLASS_TOOLS]) {
        expect(
          TOOL_CATALOG.some((t) => t.name === name),
          `${cls}: ${name}`,
        ).toBe(true);
      }
    }
  });
  it("WL-M2-1: a class with no entry fails, naming the class", () => {
    expect(() => toolsForClass("sorcery" as never)).toThrow(/sorcery/);
  });
  it("WL-M2-4: run_script is offered only when the model is marked script-capable", () => {
    for (const cls of Object.keys(CLASS_TOOLS)) {
      const names = toolsForClass(cls as never).map((t) => t.name);
      expect(names, cls).not.toContain("run_script");
    }
    expect(
      toolsForClass("spike", TOOL_CATALOG, { scriptCapable: true }).map((t) => t.name),
    ).toContain("run_script");
  });
});

describe("the session's structure (T3, M3, M2)", () => {
  let wt: string;
  const sandbox = new ProcessSandbox();
  const gateRunner = new DeterministicGateRunner(sandbox);
  beforeEach(() => {
    wt = mkdtempSync(join(tmpdir(), "sekhemet-b21-"));
    writeFileSync(join(wt, "index.ts"), "export const x = 1;\n");
  });
  afterEach(() => rmSync(wt, { recursive: true, force: true }));

  const usage = { promptTokens: 100, completionTokens: 20, durationMs: 1 };
  const read = (id: string): InferenceResponse => ({
    text: "",
    toolCalls: [{ id, name: "read_file", arguments: { path: "index.ts" } }],
    usage,
  });
  function windowed(responses: InferenceResponse[]) {
    const m = new MockInferenceAdapter("mock", responses);
    Object.defineProperty(m, "contextWindow", {
      value: { contextTokens: 16_384, maxTokens: 4_096 },
    });
    return m;
  }
  const session = (
    modelAdapter: MockInferenceAdapter,
    extra: Partial<ConstructorParameters<typeof CardExecutionSessionImpl>[0]> = {},
  ) =>
    new CardExecutionSessionImpl({
      cardId: "c1",
      stepBudget: 10,
      worktreePath: wt,
      scopeFiles: ["index.ts"],
      modelAdapter,
      gateRunner,
      ...extra,
    });

  it("WL-T3-1: records the phase on each step result", async () => {
    const s = session(windowed([read("a")]));
    const turn = await s.executeTurn();
    expect(turn.phase).toBe("find");
  });

  it("WL-T3-3 (structural): an oscillation stop names the repeated call", async () => {
    const s = session(windowed([read("a"), read("b"), read("c")]));
    await s.executeTurn();
    await s.executeTurn();
    const turn = await s.executeTurn();
    expect(turn.stopReason).toBe("oscillation_detected");
    expect(turn.repeatedCall).toMatch(/read_file/);
  });

  it("WL-T3-4: a pre-step hook veto stops with hook_veto naming the hook, not human_abort", async () => {
    const hooks = new LifecycleHookEngine();
    hooks.register("pre-step", () => ({ block: true, reason: "no steps on Fridays" }));
    const s = session(windowed([read("a")]), { hooks });
    const turn = await s.executeTurn();
    expect(turn.stopReason).toBe("hook_veto");
    expect(turn.hookVeto).toEqual({ hook: "pre-step hook 1", reason: "no steps on Fridays" });
  });

  it("WL-T3-4: a named hook's veto names the hook by its configured name, not its position", async () => {
    const hooks = new LifecycleHookEngine();
    hooks.register("pre-step", () => undefined, "notify-slack");
    hooks.register("pre-step", () => ({ block: true, reason: "freeze" }), "./scripts/freeze.sh");
    const s = session(windowed([read("a")]), { hooks });
    const turn = await s.executeTurn();
    expect(turn.stopReason).toBe("hook_veto");
    expect(turn.hookVeto).toEqual({ hook: "./scripts/freeze.sh", reason: "freeze" });
  });

  it("WL-M2-5 (progressive arm): a call to a catalog tool not yet loaded runs and is not a format error", async () => {
    // Under progressive loading "offered" is the class catalog reachable
    // through tool_search: the refusal and the metric use the same set.
    const grep: InferenceResponse = {
      text: "",
      toolCalls: [{ id: "g", name: "grep_search", arguments: { query: "export" } }],
      usage,
    };
    const m = windowed([grep]);
    const s = session(m, { progressiveTools: true });
    const turn = await s.executeTurn();
    const sent = (m.callHistory.at(-1)?.tools ?? []).map((t: { name: string }) => t.name);
    expect(sent).not.toContain("grep_search");
    expect(turn.observations[0]?.ok).toBe(true);
    expect(turn.observations[0]?.deniedRule).toBeUndefined();
    expect(turn.formatErrors).toBe(0);
    expect(turn.proseOnly).toBe(0);
  });

  it("sends the one tool builder's definitions, with note's gate enum from the Worker copy", async () => {
    const m = windowed([read("a")]);
    const s = session(m, { suspectableGates: ["typecheck", "lint"] });
    await s.executeTurn();
    const sent = m.callHistory.at(-1)?.tools ?? [];
    expect(sent).toEqual(s.getToolSpecs().map(toolDefinition));
    const note = sent.find((t) => t.name === "note");
    const gate = (note?.parameters as { properties: Record<string, unknown> }).properties.gate;
    expect(gate).toEqual({
      type: "string",
      description: workerCopy.noteGate,
      // The integrity gate runs by default, so it is offered too (GT-M6-5).
      enum: ["integrity", "lint", "typecheck"],
    });
  });

  it("tells the tools whether recall is offered this session (CX-M1-1)", () => {
    const withRecall = session(windowed([]));
    expect(withRecall.getToolSpecs().some((t) => t.name === "recall")).toBe(true);
    expect(withRecall.recallOffered()).toBe(true);
    const tools = toolsForClass("implement").filter((t) => t.name !== "recall");
    expect(session(windowed([]), { tools }).recallOffered()).toBe(false);
  });

  it("refuses a call to a tool not offered this session, naming the tools that are", async () => {
    // run_script is offered only to a script-capable Worker (WL-M2-4); a
    // Worker that calls it anyway gets a refusal, and nothing runs.
    const script: InferenceResponse = {
      text: "",
      toolCalls: [
        {
          id: "s",
          name: "run_script",
          arguments: { code: "require('fs').writeFileSync('ran.txt', 'x')" },
        },
      ],
      usage,
    };
    const s = session(windowed([script]));
    const turn = await s.executeTurn();
    const [obs] = turn.observations;
    expect(obs?.ok).toBe(false);
    expect(obs?.denied).toBe(true);
    expect(obs?.deniedRule).toBe("not_offered");
    expect(obs?.content).toMatch(/run_script is not available on this card/);
    expect(obs?.content).toMatch(/read_file/);
    expect(obs?.content).not.toMatch(/\brun_script\b.*\brun_script\b/);
    expect(obs?.content.split("\n")).toHaveLength(1);
    expect(existsSync(join(wt, "ran.txt"))).toBe(false);
  });

  it("WL-T3-12: a context stop is budget_exhausted with the detail context; a spent step budget is steps", async () => {
    const tight = session(windowed([read("a")]), { promptTokenBudget: 50 });
    const stopped = await tight.executeTurn();
    expect(stopped.stopReason).toBe("budget_exhausted");
    expect(stopped.budget?.budget).toBe("context");
    if (stopped.budget?.budget === "context") {
      expect(stopped.budget.cap).toBeGreaterThan(0);
      expect(stopped.budget.tokens).toBeGreaterThan(stopped.budget.cap);
      expect(stopped.budget.zone.length).toBeGreaterThan(0);
    }
    const s = session(windowed([read("a"), read("b")]), { stepBudget: 1 });
    const turn = await s.executeTurn();
    expect(turn.budget).toEqual({ budget: "steps", used: 1, of: 1 });
  });

  it("WL-M3-1, WL-M3-5: W is fixed from the largest thinking cap and every request fits the window", async () => {
    for (const thinking of ["off", "surgical", "all"] as const) {
      const m = windowed([read("a"), read("b"), read("c")]);
      const s = session(m, { thinking });
      // 16,384 − 4,096 − 2,048 − 256 (rule 22).
      expect(s.getPromptBudget(), thinking).toBe(9_984);
      for (let i = 0; i < 3; i++) {
        await s.executeTurn();
        const req = m.callHistory.at(-1);
        const prompt = s.getLastContextReport()?.metrics.usedTokens ?? 0;
        expect(prompt).toBeGreaterThan(0);
        expect(prompt + 4_096 + (req?.reasoningBudgetTokens ?? 0) + 256).toBeLessThanOrEqual(
          16_384,
        );
      }
    }
  });

  it("WL-M3-3: thinking `all` uses REASONING_BUDGET_TOKENS.high and the session holds no literal budget", async () => {
    const m = windowed([read("a")]);
    await session(m, { thinking: "all" }).executeTurn();
    expect(m.callHistory[0]?.reasoningBudgetTokens).toBe(REASONING_BUDGET_TOKENS.high);
    const src = code(join(ROOT, "packages/loop/src/session.ts"));
    expect(src).not.toMatch(/reasoningBudgetTokens:\s*\d/);
    expect(src).not.toMatch(/\b(512|1024|2048|1_024|2_048)\b/);
  });

  it("WL-M3-2: a reply cut off by length is a typed truncated record, not a stall or a silent step", async () => {
    const cut: InferenceResponse = {
      text: "",
      toolCalls: [],
      usage: { ...usage, thinkingTokens: 2_048, answerTokens: 0 },
      finishReason: "length",
    };
    const s = session(windowed([cut, cut, cut, cut, read("a")]), { thinking: "all" });
    for (let i = 0; i < 4; i++) {
      const turn = await s.executeTurn();
      expect(turn.truncated).toEqual({ cut: "thinking", capTokens: REASONING_BUDGET_TOKENS.high });
      // Three silent steps would stop the card (rule 19); truncated ones do not count.
      expect(turn.stopReason).toBeUndefined();
    }
    const after = await s.executeTurn();
    expect(after.stopReason).toBeUndefined();
    // With thinking off, a cut reply was cut while answering, at the answer cap.
    const answer = await session(
      windowed([{ text: "read_file(pa", toolCalls: [], usage, finishReason: "length" }]),
    ).executeTurn();
    expect(answer.truncated).toEqual({ cut: "answer", capTokens: 4_096 });
  });

  it("WL-M3-4: the step result carries finish_reason, prompt, thinking and answer tokens", async () => {
    const m = windowed([
      {
        ...read("a"),
        usage: { ...usage, thinkingTokens: 30, answerTokens: 12 },
        finishReason: "tool_calls",
      },
    ]);
    const turn = await session(m).executeTurn();
    expect(turn.finishReason).toBe("tool_calls");
    expect(turn.usage?.promptTokens).toBe(100);
    expect(turn.usage?.thinkingTokens).toBe(30);
    expect(turn.usage?.answerTokens).toBe(12);
  });

  it("WL-M2-5: each step counts its tool-call format errors apart from prose-only replies, and the session names its tool arm", async () => {
    const m = windowed([
      // Prose with no tool call: prose-only, not a format error.
      { text: "I think I should read", toolCalls: [], usage },
      // A call to a tool that does not exist: a format error.
      { text: "", toolCalls: [{ id: "x", name: "no_such_tool", arguments: {} }], usage },
      // An attempted call the parser could not read: a format error.
      { text: 'read_file(path="index.ts"', toolCalls: [], usage },
      { text: '```json\n{"name": "read_file", "arguments": {"path": \n```', toolCalls: [], usage },
      read("a"),
    ]);
    const s = session(m);
    const prose = await s.executeTurn();
    expect([prose.formatErrors, prose.proseOnly]).toEqual([0, 1]);
    const unknown = await s.executeTurn();
    expect([unknown.formatErrors, unknown.proseOnly]).toEqual([1, 0]);
    const broken = await s.executeTurn();
    expect([broken.formatErrors, broken.proseOnly]).toEqual([1, 0]);
    const brokenJson = await s.executeTurn();
    expect([brokenJson.formatErrors, brokenJson.proseOnly]).toEqual([1, 0]);
    const good = await s.executeTurn();
    expect([good.formatErrors, good.proseOnly]).toEqual([0, 0]);
    expect(s.getToolSetArm()).toBe("fixed");
    expect(session(windowed([]), { progressiveTools: true }).getToolSetArm()).toBe("progressive");
  });
});
