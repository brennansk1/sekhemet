import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workerCopy } from "@sekhemet/context";
import type { GateRunner } from "@sekhemet/gates";
import type { CardRecord } from "@sekhemet/kernel";
import type { InferenceRequest, LocalInferenceAdapter, ToolCall } from "@sekhemet/models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type EvidenceRecord,
  changedExportedSignatures,
  exportedSignatures,
  missingEvidence,
  readRanges,
  shownLineRanges,
} from "../src/evidence_gate.js";
import { CardExecutionSessionImpl } from "../src/session.js";

// worker-loop rule 29a and NEW-worker-loop-9: the evidence-gated commit
// (SEKHEMET_EVIDENCE_GATE). With the switch on, a write or a finish waits for
// the evidence it depends on, observed in the attempt's step records.

const read = (path: string, from: number, to: number, lines: number): EvidenceRecord => ({
  kind: "read",
  path,
  from,
  to,
  lines,
});
const write = (path: string): EvidenceRecord => ({ kind: "write", path });

describe("WL-N9-4: the precondition set is one pure function of the step records", () => {
  const firstWrite = {
    kind: "write" as const,
    path: "src/ledger.ts",
    importedScopeFiles: ["src/ledger.ts"],
    signatureChanges: [],
  };

  it("WL-N9-1: the first write waits for every imported scope file read in full", () => {
    expect(missingEvidence([], firstWrite)).toEqual({ kind: "unread", files: ["src/ledger.ts"] });
    expect(missingEvidence([read("src/ledger.ts", 1, 40, 40)], firstWrite)).toBeUndefined();
  });

  it("counts reads that together cover the file, not one partial read", () => {
    expect(missingEvidence([read("src/ledger.ts", 1, 20, 40)], firstWrite)).toEqual({
      kind: "unread",
      files: ["src/ledger.ts"],
    });
    expect(
      missingEvidence(
        [read("src/ledger.ts", 21, 40, 40), read("src/ledger.ts", 1, 20, 40)],
        firstWrite,
      ),
    ).toBeUndefined();
  });

  it("does not hold a later write to the first-write rule", () => {
    expect(missingEvidence([write("src/other.ts")], firstWrite)).toBeUndefined();
  });

  const signatureWrite = {
    kind: "write" as const,
    path: "src/a.ts",
    importedScopeFiles: [],
    signatureChanges: [{ symbol: "f", importers: ["src/b.ts", "src/c.ts"] }],
  };

  it("WL-N9-2: a signature change waits for its importers, read or searched since the file's last write", () => {
    const wrote = [write("src/a.ts")];
    expect(missingEvidence(wrote, signatureWrite)).toEqual({
      kind: "importers",
      symbol: "f",
      file: "src/a.ts",
      importers: ["src/b.ts", "src/c.ts"],
    });
    expect(
      missingEvidence(
        [...wrote, read("src/b.ts", 1, 2, 2), read("src/c.ts", 1, 1, 9)],
        signatureWrite,
      ),
    ).toBeUndefined();
    expect(
      missingEvidence(
        [...wrote, { kind: "references", symbol: "f", file: "src/a.ts" }],
        signatureWrite,
      ),
    ).toBeUndefined();
    // A search for another file's f is not evidence about this one (review minor 7).
    expect(
      missingEvidence(
        [...wrote, { kind: "references", symbol: "f", file: "src/other.ts" }],
        signatureWrite,
      ),
    ).toMatchObject({ kind: "importers" });
    // Evidence from before the last write to the file does not count.
    expect(
      missingEvidence(
        [
          { kind: "references", symbol: "f", file: "src/a.ts" },
          read("src/b.ts", 1, 2, 2),
          ...wrote,
        ],
        signatureWrite,
      ),
    ).toMatchObject({ kind: "importers" });
  });

  it("WL-N9-3: finishing waits for the tests to have run on the current tree", () => {
    expect(missingEvidence([], { kind: "finish" })).toEqual({ kind: "tests" });
    expect(
      missingEvidence([write("src/a.ts"), { kind: "tests" }], { kind: "finish" }),
    ).toBeUndefined();
    expect(missingEvidence([{ kind: "tests" }, write("src/a.ts")], { kind: "finish" })).toEqual({
      kind: "tests",
    });
  });
});

describe("read credit: as much as any read can show (follow-up 2)", () => {
  const clamped = (numbered: string[]) =>
    `src/a.ts (lines …):\n${numbered[0]}\n... [9000 chars of file omitted; 12600 total] ...\n${numbered[1]}`;

  it("credits a line longer than the clamp once it was requested alone", () => {
    const content = clamped(['    7│const huge = "xxxx', 'xxxx";']);
    expect(shownLineRanges(content, { from: 7, to: 7 })).toEqual([[7, 7]]);
    expect(
      missingEvidence(
        [{ kind: "read", path: "src/a.ts", from: 1, to: 6, lines: 7 }, read("src/a.ts", 7, 7, 7)],
        {
          kind: "write",
          path: "src/a.ts",
          importedScopeFiles: ["src/a.ts"],
          signatureChanges: [],
        },
      ),
    ).toBeUndefined();
  });

  it("does not credit that line when it came clamped inside a longer range", () => {
    const content = clamped([
      '    6│const a = 1;\n    7│const huge = "xxxx',
      'xxxx";\n    8│const b = 2;',
    ]);
    const ranges = shownLineRanges(content, { from: 6, to: 8 });
    expect(ranges.flatMap(([f, t]) => (f <= 7 && 7 <= t ? [7] : []))).toEqual([]);
  });
});

describe("exported signatures, for WL-N9-2", () => {
  const before = [
    "export function f(x: number): number {",
    "  return x;",
    "}",
    "export const LIMIT = 10;",
    "export interface Row { id: string }",
    "const hidden = (a: string) => a;",
  ].join("\n");

  it("reads each exported declaration without its body", () => {
    const sigs = exportedSignatures("a.ts", before);
    expect([...sigs.keys()].sort()).toEqual(["LIMIT", "Row", "f"]);
  });

  it("does not count a body or a value change, and counts a parameter, member or removal change", () => {
    const body = before.replace("return x;", "return x + 1;").replace("= 10", "= 20");
    expect(changedExportedSignatures("a.ts", before, body)).toEqual([]);
    const param = before.replace("f(x: number)", "f(x: number, y = 0)");
    expect(changedExportedSignatures("a.ts", before, param)).toEqual(["f"]);
    const member = before.replace("{ id: string }", "{ id: number }");
    expect(changedExportedSignatures("a.ts", before, member)).toEqual(["Row"]);
    const removed = before.replace("export const LIMIT = 10;\n", "");
    expect(changedExportedSignatures("a.ts", before, removed)).toEqual(["LIMIT"]);
  });
});

// --- the switch in a session -------------------------------------------------

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "evidence-gate-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "tests"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const usage = { promptTokens: 1, completionTokens: 1, durationMs: 1 };

function session(
  dir: string,
  calls: ToolCall[][],
  extra: Record<string, unknown> = {},
  gateRunner?: GateRunner,
) {
  const seen: InferenceRequest[] = [];
  let i = 0;
  let gateRuns = 0;
  const adapter = {
    modelId: "m",
    supportedArms: ["arm_a_flat"],
    nativeTools: true,
    generate: async (req: InferenceRequest) => {
      seen.push(req);
      return { text: "", toolCalls: calls[Math.min(i++, calls.length - 1)] ?? [], usage };
    },
  } as unknown as LocalInferenceAdapter;
  const s = new CardExecutionSessionImpl({
    cardId: "c",
    stepBudget: 8,
    worktreePath: dir,
    modelAdapter: adapter,
    gateRunner: gateRunner ?? {
      runGates: async () => {
        gateRuns++;
        return { passed: true, failures: [], durationMs: 1, rungResults: [] };
      },
    },
    integrityGate: false,
    scopeFiles: ["src/a.ts"],
    ...extra,
  });
  return { s, seen, gateRuns: () => gateRuns };
}

const card = (acceptanceTests: string[]): CardRecord => ({
  id: "c",
  tier: "task",
  title: "Ledger",
  status: "in_progress",
  scopeFiles: ["src/a.ts"],
  acceptanceTests,
  stepBudget: 8,
  stepsUsed: 0,
  createdAt: "2026-09-25T00:00:00.000Z",
  updatedAt: "2026-09-25T00:00:00.000Z",
});

const call = (name: string, args: Record<string, unknown>): ToolCall => ({
  id: name,
  name,
  arguments: args,
});

describe("WL-N9-1 in a session: an unread imported scope file holds the first write", () => {
  // Long enough that the prompt shows only part of it (the session pins
  // files up to 6,000 characters in full), and that one read of the whole
  // file is clamped in the middle (clampObservation keeps 3,600 characters).
  const big = Array.from({ length: 250 }, (_, i) => `export const value${i} = ${i};`).join("\n");
  const edit = call("edit", {
    path: "src/a.ts",
    search: "export const value0 = 0;",
    replace: "export const value0 = 1;",
  });

  it("postpones the write, suggests reads that each fit the clamp, and leaves the disk untouched", async () => {
    writeFileSync(join(root, "src", "a.ts"), `${big}\n`);
    writeFileSync(join(root, "tests", "a.spec.ts"), 'import { value0 } from "../src/a.js";\n');
    const ranges = readRanges(`${big}\n`, "src/a.ts");
    expect(ranges.length).toBeGreaterThan(1);
    const reads = ranges.map(([from, to]) =>
      call("read_file", { path: "src/a.ts", start: from, end: to }),
    );
    const { s } = session(root, [[edit], reads, [edit]], {
      evidenceGate: "on",
      card: card(["a.spec.ts"]),
    });
    const first = await s.executeTurn();
    expect(first.observations[0]).toMatchObject({
      tool: "edit",
      ok: false,
      deniedRule: "evidence_gate",
    });
    expect(first.observations[0]?.content).toContain(
      workerCopy.evidenceUnread(
        "src/a.ts",
        ranges
          .map(([f, t]) => workerCopy.readFileRangeCall("src/a.ts", String(f), String(t)))
          .join(", "),
      ),
    );
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toContain("value0 = 0;");
    await s.executeTurn();
    const third = await s.executeTurn();
    expect(third.observations[0]?.ok).toBe(true);
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toContain("value0 = 1;");
  });

  it("does not credit one read whose output was clamped in the middle (review blocker 2)", async () => {
    writeFileSync(join(root, "src", "a.ts"), `${big}\n`);
    writeFileSync(join(root, "tests", "a.spec.ts"), 'import { value0 } from "../src/a.js";\n');
    const { s } = session(
      root,
      [[call("read_file", { path: "src/a.ts", start: 1, end: 250 })], [edit]],
      { evidenceGate: "on", card: card(["a.spec.ts"]) },
    );
    const read = await s.executeTurn();
    expect(read.observations[0]?.content).toMatch(/omitted/);
    const held = await s.executeTurn();
    expect(held.observations[0]).toMatchObject({ ok: false, deniedRule: "evidence_gate" });
  });

  it("names several unread files in the plural", () => {
    expect(workerCopy.evidenceUnread("src/a.ts, src/b.ts", "x")).toMatch(/all of them/);
    expect(workerCopy.evidenceUnread("src/a.ts", "x")).toMatch(/all of it/);
  });

  it("leaves a write outside the scope to the scope refusal (review minor 5)", async () => {
    writeFileSync(join(root, "src", "a.ts"), `${big}\n`);
    writeFileSync(join(root, "src", "other.ts"), "export const o = 0;\n");
    writeFileSync(join(root, "tests", "a.spec.ts"), 'import { value0 } from "../src/a.js";\n');
    const outside = call("write_file", { path: "src/other.ts", content: "export const o = 1;\n" });
    const { s } = session(root, [[outside]], { evidenceGate: "on", card: card(["a.spec.ts"]) });
    const turn = await s.executeTurn();
    expect(turn.observations[0]?.deniedRule).not.toBe("evidence_gate");
    expect(turn.observations[0]?.ok).toBe(false);
  });
});

describe("WL-N9-2 in a session: a signature change waits for its importers", () => {
  it("postpones the change naming the importers and the find_references call", async () => {
    writeFileSync(
      join(root, "src", "a.ts"),
      "export function f(x: number): number {\n  return x;\n}\n",
    );
    writeFileSync(
      join(root, "src", "b.ts"),
      'import { f } from "./a.js";\nexport const y = f(1);\n',
    );
    const body = call("edit", { path: "src/a.ts", search: "return x;", replace: "return x + 1;" });
    const signature = call("edit", {
      path: "src/a.ts",
      search: "f(x: number)",
      replace: "f(x: number, y = 0)",
    });
    const { s } = session(
      root,
      [
        [body],
        [signature],
        [call("find_references", { symbol: "f", file: "src/a.ts" })],
        [signature],
      ],
      { evidenceGate: "on" },
    );
    expect((await s.executeTurn()).observations[0]?.ok).toBe(true);
    const held = await s.executeTurn();
    expect(held.observations[0]).toMatchObject({ ok: false, deniedRule: "evidence_gate" });
    expect(held.observations[0]?.content).toContain(
      workerCopy.evidenceImporters("f", "src/b.ts", 'find_references(symbol="f", file="src/a.ts")'),
    );
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).not.toContain("y = 0");
    await s.executeTurn();
    expect((await s.executeTurn()).observations[0]?.ok).toBe(true);
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toContain("y = 0");
  });
});

describe("WL-N9-2 with CRLF line endings (review minor 4)", () => {
  it("sees a multi-line edit's signature change as the real edit applies it", async () => {
    writeFileSync(
      join(root, "src", "a.ts"),
      "export function f(x: number): number {\r\n  return x;\r\n}\r\n",
    );
    writeFileSync(
      join(root, "src", "b.ts"),
      'import { f } from "./a.js";\nexport const y = f(1);\n',
    );
    const first = call("write_file", {
      path: "src/c.ts",
      content: "export const c = 0;\n",
    });
    const signature = call("edit", {
      path: "src/a.ts",
      search: "export function f(x: number): number {\n  return x;",
      replace: "export function f(x: number, y = 0): number {\n  return x + y;",
    });
    const { s } = session(root, [[first], [signature]], {
      evidenceGate: "on",
      scopeFiles: ["src/a.ts", "src/c.ts"],
    });
    await s.executeTurn();
    const held = await s.executeTurn();
    expect(held.observations[0]).toMatchObject({ ok: false, deniedRule: "evidence_gate" });
  });
});

describe("WL-N9-3 in a session: finishing before the tests ran on the current tree", () => {
  it("runs the check instead, and ends the card when it passes (review minor 6)", async () => {
    writeFileSync(join(root, "src", "a.ts"), "export const a = 0;\n");
    const writeA = call("write_file", { path: "src/a.ts", content: "export const a = 1;\n" });
    const finish = call("finish_card", {});
    const { s, gateRuns } = session(root, [[writeA], [finish]], { evidenceGate: "on" });
    await s.executeTurn();
    const done = await s.executeTurn();
    expect(done.stopReason).toBe("gate_passed");
    expect(done.observations[0]).toMatchObject({ tool: "finish_card", ok: true });
    expect(done.observations[0]?.content).not.toContain("finish_card again");
    expect(gateRuns()).toBe(1);
  });

  const failure = {
    rung: "typecheck" as const,
    gate: "typecheck",
    exitCode: 2,
    errorExcerpt: "src/a.ts:1:14 TS2322: bad",
    suggestedFixFiles: ["src/a.ts"],
    location: { file: "src/a.ts", line: 1 },
    expected: "type-correct program",
    actual: "TS2322: bad",
    minimalRepro: "pnpm typecheck",
    suggestedAction: "Fix it.",
  };

  it("returns the failures when the check it ran fails, and keeps the card open", async () => {
    writeFileSync(join(root, "src", "a.ts"), "export const a = 0;\n");
    const writeA = call("write_file", { path: "src/a.ts", content: "export const a = 1;\n" });
    const failing: GateRunner = {
      runGates: async () => ({ passed: false, durationMs: 1, failures: [failure] }),
    };
    const { s } = session(
      root,
      [[writeA], [call("finish_card", {})]],
      { evidenceGate: "on" },
      failing,
    );
    await s.executeTurn();
    const held = await s.executeTurn();
    expect(held.stopReason).toBeUndefined();
    expect(held.observations[0]).toMatchObject({ ok: false, deniedRule: "evidence_gate" });
    expect(held.observations[0]?.content).toContain(workerCopy.evidenceFinish);
    expect(held.observations[0]?.content).toContain("TS2322");
  });

  // Review blocker 1: a finish whose gates cannot run takes the normal path.
  const finishWith = async (gateRunner: GateRunner, evidenceGate: "on" | "off") => {
    const dir = mkdtempSync(join(tmpdir(), "evidence-notrun-"));
    try {
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src", "a.ts"), "export const a = 0;\n");
      const { s } = session(
        dir,
        [
          [call("write_file", { path: "src/a.ts", content: "export const a = 1;\n" })],
          [call("finish_card", {})],
        ],
        { evidenceGate },
        gateRunner,
      );
      await s.executeTurn();
      return (await s.executeTurn()).stopReason;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("finishes as without the gate when the gates could not run: done_pending_gates", async () => {
    const notRun: GateRunner = {
      runGates: async () => ({
        passed: false,
        durationMs: 1,
        failures: [{ ...failure, errorExcerpt: "typecheck not run", notRun: true }],
      }),
    };
    expect(await finishWith(notRun, "on")).toBe("done_pending_gates");
    expect(await finishWith(notRun, "on")).toBe(await finishWith(notRun, "off"));
  });

  it("runs the gates once on either fallback path, as without the gate (follow-up 1)", async () => {
    const counting = (behaviour: "notRun" | "throws") => {
      let runs = 0;
      const runner: GateRunner = {
        runGates: async () => {
          runs++;
          if (behaviour === "throws") throw new Error("gates.toml tampered");
          return {
            passed: false,
            durationMs: 1,
            failures: [{ ...failure, errorExcerpt: "typecheck not run", notRun: true }],
          };
        },
      };
      return { runner, runs: () => runs };
    };
    for (const behaviour of ["notRun", "throws"] as const) {
      const off = counting(behaviour);
      const on = counting(behaviour);
      await finishWith(off.runner, "off");
      await finishWith(on.runner, "on");
      expect(on.runs(), behaviour).toBe(off.runs());
      expect(on.runs(), behaviour).toBe(1);
    }
  });

  it("never throws out of the turn when the gate runner throws", async () => {
    const throwing: GateRunner = {
      runGates: async () => {
        throw new Error("gates.toml tampered");
      },
    };
    const on = await finishWith(throwing, "on");
    expect(on).toBe(await finishWith(throwing, "off"));
  });
});

describe("WL-N9-4: with the switch off the loop is unchanged", () => {
  const script = (): ToolCall[][] => [
    [call("write_file", { path: "src/a.ts", content: "export const a = 1;\n" })],
    [call("finish_card", {})],
  ];
  const run = async (extra: Record<string, unknown>) => {
    const dir = mkdtempSync(join(tmpdir(), "evidence-off-"));
    try {
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src", "a.ts"), "export const a = 0;\n");
      const { s, seen } = session(dir, script(), extra);
      const turns = [await s.executeTurn(), await s.executeTurn()];
      return JSON.stringify({ seen, turns }).split(dir).join("$ROOT");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("sends the same requests and gets the same observations as without the option", async () => {
    const without = await run({});
    expect(await run({ evidenceGate: "off" })).toBe(without);
    // And the switch is not a no-op: on, the finish is postponed.
    expect(await run({ evidenceGate: "on" })).not.toBe(without);
  });
});
