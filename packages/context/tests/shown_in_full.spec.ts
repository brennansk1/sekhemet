import type { GateFailure } from "@sekhemet/gates";
import type { CardRecord } from "@sekhemet/kernel";
import { describe, expect, it } from "vitest";
import { InMemoryEvidenceStore } from "../src/evidence.js";
import { findContradictions } from "../src/prompt_lint.js";
import { workerCopy } from "../src/worker_copy.js";
import { type WorkerPromptInput, buildWorkerPrompt } from "../src/worker_prompt.js";

// The B2.1 review, B2: "current content is shown" only when it is. A scope
// file's header, the ready-to-verify tail and the Worker's edit refusal say
// so only for a file shown in full; otherwise they give the read_file call.

const card: CardRecord = {
  id: "card_ledger",
  tier: "task",
  title: "Ledger store",
  status: "in_progress",
  scopeFiles: ["src/ledger.ts"],
  stepBudget: 40,
  stepsUsed: 8,
  createdAt: "2026-09-18T00:00:00.000Z",
  updatedAt: "2026-09-18T00:00:00.000Z",
};
const big = Array.from({ length: 400 }, (_, i) => `export const v${i} = ${i};`).join("\n");

const input = (content: string, extra: Partial<WorkerPromptInput> = {}): WorkerPromptInput => ({
  card,
  tools: [],
  evidenceStore: new InMemoryEvidenceStore(),
  goal: "Store ledger entries.",
  scopeFiles: [{ path: "src/ledger.ts", content }],
  readyToVerify: true,
  ...extra,
});

describe("a scope file shown in full, and one that is not", () => {
  it("says current content and copy-from-above only when the file is shown in full", () => {
    const built = buildWorkerPrompt(input("export const rows = [];\n"));
    expect(built.shownInFull).toEqual(["src/ledger.ts"]);
    expect(built.prompt).toContain(workerCopy.scopeFileHeader("src/ledger.ts", true));
    expect(built.prompt).toContain(workerCopy.nextActionReady);
  });

  it("marks a shrunk scope file as partial and gives the read_file call instead", () => {
    const built = buildWorkerPrompt(input(big, { budgetTokens: 2_500 }));
    expect(built.shownInFull).toEqual([]);
    expect(built.prompt).toContain(workerCopy.scopeFileHeader("src/ledger.ts", false));
    expect(built.prompt).not.toContain("do not read_file it");
    expect(built.prompt).toContain(workerCopy.nextActionReadyRead(["src/ledger.ts"]));
    expect(findContradictions(`${built.systemPrompt}\n\n${built.prompt}`)).toEqual([]);
  });

  it("treats a scope file the session left out as not shown", () => {
    const built = buildWorkerPrompt(input("", { scopeFiles: [] }));
    expect(built.shownInFull).toEqual([]);
    expect(built.prompt).toContain(workerCopy.nextActionReadyRead(["src/ledger.ts"]));
  });
});

describe("one finish_card line per tail (B6), and no placeholder in the footer (B8)", () => {
  it("does not repeat the next action as an INSTRUCTION line", () => {
    const built = buildWorkerPrompt(input("export const rows = [];\n", { readyToVerify: false }));
    expect(built.prompt.match(/finish_card/g)?.length).toBe(1);
  });

  it("writes the no-recall footer in parentheses", () => {
    expect(workerCopy.outputFooter(["40 lines condensed to 12"])).toBe(
      "(40 lines condensed to 12)",
    );
  });

  it("gives the batching example two independent calls", () => {
    expect(workerCopy.toolPreamble).not.toMatch(/write a file and then call finish_card/);
    expect(workerCopy.toolPreamble).toContain("two read_file calls");
  });
});

describe("every unshown file, and the failing lines, routed by what is shown (confirmation review)", () => {
  it("gives a read_file call for every scope file not shown in full", () => {
    const line = workerCopy.nextActionReadyRead(["src/a.ts", "src/b.ts"]);
    expect(line).toContain('read_file(path="src/a.ts", start, end)');
    expect(line).toContain('read_file(path="src/b.ts", start, end)');
  });

  const failure: GateFailure = {
    rung: "typecheck",
    gate: "typecheck",
    exitCode: 2,
    errorExcerpt: "src/ledger.ts:3:7 TS9999: Something new.",
    suggestedFixFiles: ["src/ledger.ts"],
    location: { file: "src/ledger.ts", line: 3 },
    expected: "type-correct program",
    actual: "TS9999: Something new.",
    minimalRepro: "pnpm typecheck",
    suggestedAction: "Resolve TS9999 at src/ledger.ts:3.",
  };

  it("adds no read instruction for a failing file shown in full", () => {
    const built = buildWorkerPrompt(
      input("export const rows = [];\n", { readyToVerify: false, gateFailures: [failure] }),
    );
    expect(built.prompt).not.toContain(workerCopy.readAround("src/ledger.ts", 3));
    expect(findContradictions(`${built.systemPrompt}\n\n${built.prompt}`)).toEqual([]);
  });

  it("gives the read_file call for a failing file the prompt does not show", () => {
    const built = buildWorkerPrompt(
      input("", { scopeFiles: [], readyToVerify: false, gateFailures: [failure] }),
    );
    expect(built.prompt).toContain(workerCopy.readAround("src/ledger.ts", 3));
  });
});
