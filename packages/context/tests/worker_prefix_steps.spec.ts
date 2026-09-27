import type { CardRecord } from "@sekhemet/kernel";
import { describe, expect, it } from "vitest";
import { InMemoryEvidenceStore } from "../src/evidence.js";
import type { ToolInterfaceSpec } from "../src/tool_interface.js";
import { type WorkerPromptInput, buildWorkerPrompt } from "../src/worker_prompt.js";

/**
 * Live-test F5 (context rules 2, 5 and 10a; CX-M8-2): two consecutive steps
 * of one attempt share everything but the volatile tail — the system prompt
 * and the static per-card blocks byte for byte — so the server's prefix cache
 * re-reads only the tail. What changes between steps (the step counter, a
 * write to a scope file, one more step of history, the working memory) sits
 * after the static part.
 */
const card = (stepsUsed: number): CardRecord => ({
  id: "card_f5",
  tier: "task",
  title: "Ledger store",
  status: "in_progress",
  scopeFiles: ["src/ledger.ts"],
  stepBudget: 40,
  stepsUsed,
  createdAt: "2026-09-26T00:00:00.000Z",
  updatedAt: "2026-09-26T00:00:00.000Z",
});
const tools: ToolInterfaceSpec[] = [
  { name: "read_file", summary: "Read a file.", parameters: [] },
  { name: "finish_card", summary: "Submit the card for verification.", parameters: [] },
];
const body = (tag: string, n: number) =>
  Array.from({ length: n }, (_, i) => `const ${tag}${i} = ${i}; // ${tag} line ${i}`).join("\n");

/** Step `n` of one attempt: n turns of history, the scope file as the last write left it. */
const step = (n: number): WorkerPromptInput => ({
  card: card(n),
  tools,
  evidenceStore: new InMemoryEvidenceStore(),
  budgetTokens: 12_000,
  goal: "Store ledger rows.",
  acceptanceCriteria: ["rows persist", "totals balance"],
  acceptanceTests: [{ path: "tests/ledger.test.ts", content: body("t", 40) }],
  scopeFiles: [{ path: "src/ledger.ts", content: `${body("s", 30)}\n// edit ${n}` }],
  dossier: [{ label: "From the team (this card)", text: "Use the existing table." }],
  teamNote: body("team", 10),
  repoMap: body("map", 40),
  lessons: n > 3 ? ["fixed: TS2304 in src/ledger.ts (do not reintroduce)"] : [],
  turns: Array.from({ length: n }, (_, i) => ({
    turn: i + 1,
    action: `read_file(src/f${i}.ts)`,
    result: body(`h${i}`, 6),
  })),
  completedWork: n > 2 ? ["wrote the store"] : [],
  openTodos: ["balance totals"],
});

const commonPrefix = (a: string, b: string): number => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
};

/** Where the volatile tail starts in a prompt: the scope file, the first per-step section. */
const tailStart = (prompt: string): number => {
  const at = prompt.indexOf("const s0 = 0;");
  expect(at).toBeGreaterThan(0);
  return prompt.lastIndexOf("\n\n", at);
};

describe("F5: consecutive Worker steps share everything but the volatile tail", () => {
  for (const n of [2, 3, 6]) {
    it(`step ${n} and step ${n + 1} share the system prompt and the static blocks byte for byte`, () => {
      const a = buildWorkerPrompt(step(n));
      const b = buildWorkerPrompt(step(n + 1));
      expect(a.stop).toBe(false);
      expect(b.stop).toBe(false);
      expect(b.systemPrompt).toBe(a.systemPrompt);
      expect(b.prefixHash).toBe(a.prefixHash);
      expect(b.staticPrefixHash).toBe(a.staticPrefixHash);
      const whole = (r: typeof a) => `${r.systemPrompt}\n\n${r.prompt}`;
      const shared = commonPrefix(whole(a), whole(b));
      // Everything before the volatile tail is shared; the tail alone differs.
      expect(shared).toBeGreaterThanOrEqual(a.systemPrompt.length + 2 + tailStart(a.prompt));
      // Nothing per step (the step counter) sits before the tail.
      const staticText = whole(a).slice(0, shared);
      expect(staticText).not.toMatch(/Step: \d+\/\d+/);
    });
  }

  it("keeps the static prefix over thirty steps as the history grows under a tight budget", () => {
    for (const budgetTokens of [6_000, 9_000, 12_000]) {
      const hashes = new Set<string>();
      for (let n = 1; n <= 30; n++) {
        const r = buildWorkerPrompt({ ...step(n), budgetTokens });
        expect(r.stop).toBe(false);
        hashes.add(r.staticPrefixHash);
      }
      expect(hashes.size).toBe(1);
    }
  });
});
