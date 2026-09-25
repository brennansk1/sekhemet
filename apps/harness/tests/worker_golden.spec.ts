import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PlaybookRegistry, PlaybookRule } from "@sekhemet/context";
import {
  type GateFailure,
  type GateResult,
  type GateRunner,
  defaultParserRegistry,
} from "@sekhemet/gates";
import type { CardRecord } from "@sekhemet/kernel";
import { CardExecutionSessionImpl, toolsForClass } from "@sekhemet/loop";
import { type InferenceRequest, MockInferenceAdapter, type ToolCall } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";

// PROMPT_STANDARD rule 35.2 and context CX-M1-1: golden renders of the
// Worker's prompt, each the whole request a real session sends on a fixture
// worktree — first step, ready to verify, repair, the fresh-context rung,
// after masking, without recall, with progressive tool loading — with the
// rules, repo map and lessons a session carries. Any change to the Worker's
// text shows as a diff in __golden__/; accept it with `vitest -u` only for an
// intended change, in the same change as the text. The tool definitions are
// stored as .txt so the formatter leaves the JSON exactly as the test writes it.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const FILES: Record<string, string> = {
  "package.json": '{ "name": "ledger", "type": "module", "private": true }\n',
  "src/types.ts": ["export interface Entry {", "  id: number;", "  amount: number;", "}", ""].join(
    "\n",
  ),
  "src/ledger.ts": [
    'import type { Entry } from "./types.js";',
    "",
    "export const rows: Entry[] = [];",
    "",
    "export function append(entry: Entry): void {",
    "  rows.push(entry);",
    "}",
    "",
  ].join("\n"),
  "tests/ledger.spec.ts": [
    'import { describe, expect, it } from "vitest";',
    'import { append, rows } from "../src/ledger.js";',
    "",
    'describe("ledger", () => {',
    '  it("appends one entry", () => {',
    "    append({ id: 1, amount: 2 });",
    "    expect(rows).toHaveLength(1);",
    "  });",
    "});",
    "",
  ].join("\n"),
};

/** A git worktree on a card branch, seeded with a small ledger project. */
function worktree(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sekhemet-golden-")));
  dirs.push(root);
  for (const [path, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const git = (...a: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=T", ...a], {
      cwd: root,
      stdio: "ignore",
    });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  git("checkout", "-q", "-b", "card");
  return root;
}

const card: CardRecord = {
  id: "card_ledger",
  tier: "task",
  title: "Ledger store",
  status: "in_progress",
  scopeFiles: ["src/ledger.ts"],
  stepBudget: 40,
  stepsUsed: 0,
  createdAt: "2026-09-18T00:00:00.000Z",
  updatedAt: "2026-09-18T00:00:00.000Z",
  spec: "Store ledger entries in order and list them back.",
  acceptanceCriteria: ["append adds one entry", "list returns the entries in order"],
  acceptanceTests: ["ledger.spec.ts"],
};

/** The gates a card runner offers `note` for a project with the usual gates. */
const GATES = ["typecheck", "lint", "unit"];

/** A project rule and an error-scoped rule, as a session matches them. */
const RULES: PlaybookRule[] = [
  {
    id: "rule_node_sqlite",
    pattern: "src/",
    instruction: "Use the built-in `node:sqlite` module.",
  },
  {
    id: "rule_ts2322",
    pattern: "src/",
    errorPattern: "TS2322",
    instruction: "Check the declared type before changing a value's type.",
  },
];
const playbook = {
  matchRules: (opts: { failureText?: string }) =>
    RULES.filter((r) => !r.errorPattern || opts.failureText?.includes(r.errorPattern)),
  getAllRules: () => RULES,
} as unknown as PlaybookRegistry;

/** The failure the tsc parser gives for this worktree, remedy included. */
function tscFailure(root: string): GateFailure {
  const [f] = defaultParserRegistry.parse({
    gate: {
      id: "typecheck",
      rung: "typecheck",
      layer: "static",
      command: "pnpm",
      args: ["typecheck"],
      timeoutMs: 60_000,
      parser: "tsc",
      blocking: true,
    },
    exitCode: 2,
    stdout: "src/ledger.ts(3,14): error TS2322: Type 'string' is not assignable to type 'Entry[]'.",
    stderr: "",
    minimalRepro: "pnpm typecheck",
    cwd: root,
  });
  return f as GateFailure;
}

/** Gates that fail with the tsc failure the parser gives for this worktree. */
function failingGates(root: string): GateRunner {
  return {
    runGates: async (): Promise<GateResult> => ({
      passed: false,
      failures: [tscFailure(root)],
      durationMs: 1,
      rungResults: [],
    }),
  };
}

const call = (name: string, args: Record<string, unknown>, n: number): ToolCall => ({
  id: `c${n}`,
  name,
  arguments: args,
});
const read = (path: string, n: number) => call("read_file", { path }, n);
const writeLedger = (n: number) =>
  call(
    "write_file",
    { path: "src/ledger.ts", content: `${FILES["src/ledger.ts"]}\nexport const total = 0;\n` },
    n,
  );
const finish = (n: number) => call("finish_card", {}, n);

/** Run a session over `script`, one reply per step, and return every request it sent. */
async function requests(
  script: ToolCall[][],
  extra: Record<string, unknown> = {},
): Promise<{ root: string; sent: InferenceRequest[] }> {
  const root = worktree();
  const model = new MockInferenceAdapter(
    "mock",
    script.map((toolCalls) => ({
      text: "",
      toolCalls,
      usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
    })),
    { exhaustion: "default" },
  );
  const session = new CardExecutionSessionImpl({
    cardId: card.id,
    card,
    stepBudget: 40,
    worktreePath: root,
    scopeFiles: card.scopeFiles,
    modelAdapter: model,
    gateRunner: failingGates(root),
    suspectableGates: GATES,
    playbookRegistry: playbook,
    priorLessons: ["append must keep entries in insertion order"],
    bounds: { maxFiles: 3, maxLines: 200 },
    ...extra,
  });
  for (let i = 0; i < script.length; i++) {
    const turn = await session.executeTurn();
    if (turn.stopReason) break;
  }
  return { root, sent: model.callHistory };
}

/** The request as text, the worktree's path written as $WORKTREE. */
function request(req: InferenceRequest | undefined, root: string): string {
  if (!req) throw new Error("no request was sent");
  const text = `${req.systemPrompt ?? ""}\n\n----- per-step tail -----\n\n${req.prompt}\n`;
  return text.split(root).join("$WORKTREE");
}

describe("golden renders of the Worker's prompt, from a real session (rule 35.2)", () => {
  it("renders the native tool definitions the session sends", async () => {
    const { sent } = await requests([[read("src/types.ts", 1)]]);
    expect((sent[0]?.tools ?? []).map((t) => t.name)).toEqual(
      toolsForClass("implement").map((t) => t.name),
    );
    const note = sent[0]?.tools?.find((t) => t.name === "note");
    expect(
      (note?.parameters as { properties: Record<string, { enum?: string[] }> }).properties.gate
        ?.enum,
    ).toEqual(["bounds", "integrity", "lint", "typecheck", "unit"]);
    await expect(`${JSON.stringify(sent[0]?.tools ?? [], null, 2)}\n`).toMatchFileSnapshot(
      "./__golden__/worker.tool_definitions.txt",
    );
  });

  it("renders the first step", async () => {
    const { root, sent } = await requests([[read("src/types.ts", 1)]]);
    await expect(request(sent[0], root)).toMatchFileSnapshot("./__golden__/worker.first_step.txt");
  });

  it("renders ready to verify, a repair step and the fresh-context rung", async () => {
    // Write the scope file, then finish against a failing typecheck: the
    // first failure is a direct repair, and after the second the ladder moves
    // to the fresh-context rung (ladder.ts: direct_repair has two attempts).
    const { root, sent } = await requests([
      [writeLedger(1)],
      [finish(2)],
      [finish(3)],
      [finish(4)],
    ]);
    await expect(request(sent[1], root)).toMatchFileSnapshot(
      "./__golden__/worker.ready_to_verify.txt",
    );
    await expect(request(sent[2], root)).toMatchFileSnapshot("./__golden__/worker.repair_step.txt");
    const fresh = request(sent[3], root);
    expect(fresh).toContain("=== REPAIR MODE ===");
    await expect(fresh).toMatchFileSnapshot("./__golden__/worker.fresh_context.txt");
  });

  const exploring = (steps: number) =>
    Array.from({ length: steps }, (_, i) => [
      i % 2 === 0 ? read("src/ledger.ts", i) : call("grep_search", { query: "append" }, i),
    ]);

  it("renders a step after masking and compaction", async () => {
    const { root, sent } = await requests(exploring(12));
    await expect(request(sent.at(-1), root)).toMatchFileSnapshot(
      "./__golden__/worker.post_masking.txt",
    );
  });

  it("renders a step after masking when recall is not offered", async () => {
    const { root, sent } = await requests(exploring(12), {
      tools: toolsForClass("implement").filter((t) => t.name !== "recall"),
    });
    await expect(request(sent.at(-1), root)).toMatchFileSnapshot(
      "./__golden__/worker.without_recall.txt",
    );
  });

  it("renders the first step with progressive tool loading", async () => {
    const { root, sent } = await requests([[read("src/types.ts", 1)]], { progressiveTools: true });
    await expect(request(sent[0], root)).toMatchFileSnapshot("./__golden__/worker.progressive.txt");
  });
});
