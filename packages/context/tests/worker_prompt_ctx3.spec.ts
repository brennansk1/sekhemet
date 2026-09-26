import type { GateFailure } from "@sekhemet/gates";
import type { CardRecord } from "@sekhemet/kernel";
import { describe, expect, it } from "vitest";
import type { SectionKind } from "../src/allocator.js";
import { InMemoryEvidenceStore } from "../src/evidence.js";
import type { ToolInterfaceSpec } from "../src/tool_interface.js";
import { type WorkerPromptInput, buildWorkerPrompt } from "../src/worker_prompt.js";

/** NEW-context-3 for the Worker: rule 10a's order, the rung in the tail, static blocks first. */
const card = (stepsUsed = 3): CardRecord => ({
  id: "card_c3",
  tier: "task",
  title: "Ledger store",
  status: "in_progress",
  scopeFiles: ["src/ledger.ts"],
  stepBudget: 40,
  stepsUsed,
  createdAt: "2026-09-18T00:00:00.000Z",
  updatedAt: "2026-09-18T00:00:00.000Z",
});
const tools: ToolInterfaceSpec[] = [
  { name: "finish_card", summary: "Submit the card for verification.", parameters: [] },
];
const body = (tag: string, n: number) =>
  Array.from({ length: n }, (_, i) => `const ${tag}${i} = ${i}; // ${tag} line ${i}`).join("\n");
const failure: GateFailure = {
  rung: "typecheck",
  gate: "typecheck",
  exitCode: 2,
  errorExcerpt: "src/ledger.ts:3:1 TS2554: Expected 2 arguments, but got 1.",
  suggestedFixFiles: ["src/ledger.ts"],
  location: { file: "src/ledger.ts", line: 3 },
  expected: "type-correct program",
  actual: "TS2554: Expected 2 arguments, but got 1.",
  minimalRepro: "pnpm typecheck",
  suggestedAction: "Resolve TS2554 at src/ledger.ts:3.",
};

const full = (over: Partial<WorkerPromptInput> = {}): WorkerPromptInput => ({
  card: card(),
  tools,
  evidenceStore: new InMemoryEvidenceStore(),
  goal: "Store ledger rows.",
  acceptanceTests: [{ path: "tests/ledger.test.ts", content: body("t", 60) }],
  scopeFiles: [{ path: "src/ledger.ts", content: body("s", 60) }],
  dossier: [{ label: "From the team (this card)", text: "Use the existing table." }],
  teamNote: body("team", 20),
  repoMap: body("map", 80),
  lessons: ["fixed: TS2304 in src/ledger.ts (do not reintroduce)"],
  rules: [
    {
      id: "r_err",
      pattern: "Ledger",
      instruction: "Pass both arguments.",
      errorPattern: "TS2554",
    },
  ],
  turns: Array.from({ length: 3 }, (_, i) => ({
    turn: i + 1,
    action: "read_file(src/ledger.ts)",
    result: body(`h${i}`, 10),
  })),
  gateFailures: [failure],
  ...over,
});

/** Rule 10a's Worker order, highest first: what is cut last comes first. */
const ORDER: SectionKind[] = [
  "tests",
  "failure",
  "scope_file",
  "dossier",
  "lessons",
  "error_rules",
  "history_recent",
  "repo_map",
  "team",
];

/** Text only a section below the scope files carries. */
const LOWER_MARKERS: Record<string, string> = {
  dossier: "Use the existing table.",
  lessons: "fixed: TS2304",
  error_rules: "Pass both arguments.",
  repo_map: "const map0",
  team: "const team0",
};

describe("NEW-context-3 for the Worker", () => {
  it("CX-N3-2: cuts from the lowest priority up; the acceptance test and a pinned scope file only when nothing lower remains", () => {
    const whole = buildWorkerPrompt(full({ budgetTokens: 200_000 })).usedTokens;
    const cutAt = new Map<SectionKind, number>();
    for (let budget = whole; budget > 500; budget -= 25) {
      let r: ReturnType<typeof buildWorkerPrompt>;
      try {
        r = buildWorkerPrompt(full({ budgetTokens: budget }));
      } catch {
        continue; // a zone assertion below the floor: not what this test measures
      }
      const cut = new Set(
        r.events
          .filter((e) => e.action !== "deduplicated" && e.action !== "capped")
          .map((e) => e.kind),
      );
      for (const k of cut) if (!cutAt.has(k)) cutAt.set(k, budget);
      if (cut.has("tests") || cut.has("scope_file")) {
        // Every lower section is gone from what is sent (dropped, or removed by a pressure tier).
        const text = `${r.systemPrompt}\n${r.prompt}`;
        for (const [k, marker] of Object.entries(LOWER_MARKERS)) {
          expect({ budget, k, present: text.includes(marker) }).toEqual({
            budget,
            k,
            present: false,
          });
        }
      }
    }
    // Each kind is first cut at a budget no larger than the kind below it.
    const seen = ORDER.filter((k) => cutAt.has(k));
    for (let i = 1; i < seen.length; i++) {
      const higher = seen[i - 1] as SectionKind;
      const lower = seen[i] as SectionKind;
      expect({ higher, lower, order: (cutAt.get(higher) ?? 0) <= (cutAt.get(lower) ?? 0) }).toEqual(
        {
          higher,
          lower,
          order: true,
        },
      );
    }
    expect(cutAt.has("team")).toBe(true);
  });

  it("CX-N3-4: a rung directive goes to the tail; the system prompt and the static zone stay byte-identical", () => {
    const before = buildWorkerPrompt(full({ card: card(3) }));
    const after = buildWorkerPrompt(
      full({ card: card(4), rungDirective: "Discard your approach and re-read the scope files." }),
    );
    expect(after.systemPrompt).toBe(before.systemPrompt);
    expect(after.staticPrefixHash).toBe(before.staticPrefixHash);
    expect(after.prompt.indexOf("Discard your approach")).toBeGreaterThan(
      after.prompt.indexOf("src/ledger.ts"),
    );
  });

  it("CX-N3-5: the dossier's directives, the team note and a re-plan's plan come before the scope files", () => {
    const r = buildWorkerPrompt(full({ repairPlan: "PLAN: add the second argument to append()." }));
    const scope = r.prompt.indexOf("const s0");
    expect(scope).toBeGreaterThan(0);
    for (const marker of [
      "Use the existing table.",
      "const team0",
      "PLAN: add the second argument",
    ]) {
      const at = r.prompt.indexOf(marker);
      expect({ marker, before: at >= 0 && at < scope }).toEqual({ marker, before: true });
    }
  });
});
