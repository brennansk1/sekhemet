import type { GateFailure } from "@sekhemet/gates";
import type { CardRecord } from "@sekhemet/kernel";
import { describe, expect, it } from "vitest";
import { InMemoryEvidenceStore } from "../src/evidence.js";
import type { PlaybookRule } from "../src/playbook.js";
import { PrefixStabilityGuard } from "../src/prefix_guard.js";
import { linesNamedFor, pruneLines, queryTerms } from "../src/pruner.js";
import type { ToolInterfaceSpec } from "../src/tool_interface.js";
import { TOOL_SEARCH_SPEC, ToolLoader, searchTools } from "../src/tool_search.js";
import { computeContextVersion } from "../src/versioning.js";
import { workerCopy } from "../src/worker_copy.js";
import {
  type WorkerPromptInput,
  assertPromptDeterminism,
  buildWorkerPrompt,
} from "../src/worker_prompt.js";

const card = (stepsUsed: number, id = "card_w2"): CardRecord => ({
  id,
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
  {
    name: "edit",
    summary: "Replace exact text in a file.",
    parameters: [
      { name: "path", type: "string", required: true, description: "file" },
      { name: "search", type: "string", required: true, description: "old text" },
      { name: "replace", type: "string", required: true, description: "new text" },
    ],
  },
  { name: "finish_card", summary: "Submit the card for verification.", parameters: [] },
];
const grep: ToolInterfaceSpec = {
  name: "grep",
  summary: "Search file contents for a regular expression.",
  parameters: [{ name: "pattern", type: "string", required: true, description: "regex" }],
};

const ruleA: PlaybookRule = {
  id: "rule_a",
  pattern: "src/",
  triggerGate: "typecheck",
  instruction: "Optional properties may be omitted but never set to undefined.",
};
const ruleB: PlaybookRule = { id: "rule_b", pattern: "src/", instruction: "Use node:sqlite." };
const ruleC: PlaybookRule = {
  id: "rule_c",
  pattern: "src/",
  instruction: "Prefer prepared statements.",
};

const failure: GateFailure = {
  rung: "typecheck",
  exitCode: 2,
  errorExcerpt:
    "src/ledger.ts:61:5 error TS2322: Type 'undefined' is not assignable to type 'number'.",
  suggestedFixFiles: ["src/ledger.ts"],
} as GateFailure;

const base = (over: Partial<WorkerPromptInput> = {}): WorkerPromptInput => ({
  card: card(1),
  tools,
  rules: [ruleA, ruleB],
  evidenceStore: new InMemoryEvidenceStore(),
  ...over,
});

describe("C4: the system prompt is pinned for the whole card", () => {
  it("re-ranking after a gate failure does not change the system prompt order", () => {
    const first = buildWorkerPrompt(base({ rules: [ruleB, ruleA] }));
    const reranked = buildWorkerPrompt(base({ rules: [ruleA, ruleB], card: card(2) }));
    expect(reranked.systemPrompt).toBe(first.systemPrompt);
  });

  it("with a guard, rules that enter mid-card go to the tail and the prefix hash holds", () => {
    const guard = new PrefixStabilityGuard();
    const t1 = buildWorkerPrompt(base({ prefixGuard: guard }));
    const t2 = buildWorkerPrompt(
      base({
        prefixGuard: guard,
        card: card(2),
        rules: [ruleA, ruleB, ruleC],
        gateFailures: [failure],
        rungDirective: "Re-read the failing line before editing.",
      }),
    );
    expect(t2.prefixHash).toBe(t1.prefixHash);
    expect(t2.systemPrompt).not.toContain("prepared statements");
    expect(t2.prompt).toContain("Prefer prepared statements.");
    expect(t2.prompt).toContain("REPAIR MODE");
    expect(t2.rulesUsed.sort()).toEqual(["rule_a", "rule_b", "rule_c"]);
    expect(t2.metrics.prefixStable).toBe(true);
    expect(guard.drifts).toEqual([]);
    expect(() => guard.assertStable("card_w2")).not.toThrow();
  });

  it("pressure later in the card cannot collapse the pinned skills", () => {
    const guard = new PrefixStabilityGuard();
    const skills = [
      {
        name: "sqlite",
        description: "SQLite patterns",
        triggers: ["ledger"],
        content: "Use WAL. ".repeat(40),
      },
    ];
    const t1 = buildWorkerPrompt(base({ prefixGuard: guard, skills, budgetTokens: 20_000 }));
    const t2 = buildWorkerPrompt(
      base({
        prefixGuard: guard,
        skills,
        card: card(9),
        budgetTokens: 1_000,
        repoMap: "src/ledger.ts:\n  export class Ledger\n".repeat(60),
      }),
    );
    expect(t2.tier).not.toBe("nominal");
    expect(t2.systemPrompt).toBe(t1.systemPrompt);
    expect(t2.systemPrompt).toContain("### Skill: sqlite");
  });

  it("the guard records drift and assertStable throws", () => {
    const guard = new PrefixStabilityGuard();
    guard.pin({
      cardId: "c",
      systemPrompt: "x",
      prefixHash: "aaa",
      ruleIds: [],
      disclosure: "full",
      versionHash: "v",
    });
    expect(guard.observe("c", "bbb")).toBe(false);
    expect(() => guard.assertStable("c")).toThrow(/drifted/);
  });
});

describe("C14/C20/C21: pack record, metrics and joint version", () => {
  it("returns a pack with per-zone tokens and a version that changes with any of the three", () => {
    const r = buildWorkerPrompt(base({ repoMap: "src/ledger.ts:\n  export class Ledger" }));
    expect(r.pack.id).toMatch(/^ctx_[0-9a-f]{16}$/);
    expect(r.pack.zoneTokens.system).toBeGreaterThan(0);
    expect(r.pack.zoneTokens.static).toBeGreaterThan(0);
    expect(r.pack.version).toBe(r.versionHash);
    expect(r.metrics).toMatchObject({ step: 1, tier: "nominal", rulesInPrompt: 2 });
    const v1 = computeContextVersion({ tools, rules: [ruleA] });
    expect(computeContextVersion({ tools, rules: [ruleA] }).version).toBe(v1.version);
    expect(computeContextVersion({ tools, rules: [ruleA, ruleB] }).playbook).not.toBe(v1.playbook);
    expect(computeContextVersion({ tools: [...tools, grep], rules: [ruleA] }).tools).not.toBe(
      v1.tools,
    );
    expect(computeContextVersion({ tools, rules: [ruleA], templates: ["x"] }).prompt).not.toBe(
      v1.prompt,
    );
  });

  it("counts masked observations in the metrics", () => {
    const r = buildWorkerPrompt(
      base({
        turns: Array.from({ length: 5 }, (_, i) => ({
          turn: i + 1,
          action: "read_file",
          result: "line\n".repeat(10),
        })),
      }),
    );
    expect(r.metrics.maskedObservations).toBe(3);
  });
});

describe("C15: determinism", () => {
  it("identical inputs give identical bytes, asserted at runtime", () => {
    const input = base({ gateFailures: [failure] });
    const r = assertPromptDeterminism(input);
    expect(r.deterministic).toBe(true);
    expect(buildWorkerPrompt(input).deterministic).toBe(true);
  });
});

describe("C22: project conventions in Zone 2", () => {
  it("folds the conventions into the system prompt", () => {
    const r = buildWorkerPrompt(base({ conventions: "- Run pnpm lint before committing." }));
    expect(r.systemPrompt).toContain("=== PROJECT CONVENTIONS ===");
    expect(r.systemPrompt).toContain("Run pnpm lint before committing.");
    expect(r.prompt).not.toContain("PROJECT CONVENTIONS");
  });
});

describe("C13: exemplars in the static zone", () => {
  it("renders the class's worked examples before the volatile tail", () => {
    const r = buildWorkerPrompt(
      base({
        exemplars: [
          {
            cardId: "c1",
            cardClass: "task:ts:feature",
            title: "Add ledger",
            trajectory: ["write src/ledger.ts -> ok", "check test -> pass"],
            steps: 2,
            tokens: 900,
            date: "2026-09-01",
          },
        ],
      }),
    );
    expect(r.prompt).toContain("WORKED EXAMPLES FROM THIS REPO");
    expect(r.prompt.indexOf("WORKED EXAMPLES")).toBeLessThan(r.prompt.indexOf("GOAL"));
    expect(r.systemPrompt).not.toContain("WORKED EXAMPLES");
  });

  it("WL-N5-1: names the exemplars that reached the prompt, by source card", () => {
    const ex = (cardId: string, lines: number) => ({
      cardId,
      cardClass: "task:ts:feature",
      title: `Card ${cardId}`,
      trajectory: Array.from({ length: lines }, (_, i) => `write src/f${i}.ts -> ok`),
      steps: lines,
      tokens: 900,
      date: "2026-09-01",
    });
    const r = buildWorkerPrompt(base({ exemplars: [ex("c1", 2), ex("c2", 2)] }));
    expect(r.exemplarsUsed).toEqual(["c1", "c2"]);
    // One too long for the exemplar block is not in the prompt, and not named.
    const long = buildWorkerPrompt(base({ exemplars: [ex("c1", 2), ex("c3", 400)] }));
    expect(long.exemplarsUsed).toEqual(["c1"]);
    expect(buildWorkerPrompt(base({})).exemplarsUsed).toEqual([]);
  });
});

describe("C19: tool_search", () => {
  it("indexes every tool in the system prompt; loaded ones go to the tail", () => {
    const loader = new ToolLoader([...tools, grep], ["edit", "finish_card"]);
    const before = buildWorkerPrompt(
      base({ tools: loader.visibleSpecs(), toolIndex: [...tools, grep] }),
    );
    expect(before.systemPrompt).toContain("- grep: Search file contents");
    expect(before.systemPrompt).toContain("tool_search(");
    expect(before.systemPrompt).not.toContain("pattern*");
    const found = loader.handle("regular expression");
    expect(found.loaded).toEqual(["grep"]);
    expect(found.text).toContain("pattern*: string");
    const after = buildWorkerPrompt(
      base({
        tools: loader.visibleSpecs().filter((t) => t.name !== "grep"),
        toolIndex: [...tools, grep],
        loadedTools: [grep],
        card: card(2),
      }),
    );
    expect(after.systemPrompt).toBe(before.systemPrompt);
    expect(after.prompt).toContain("TOOLS LOADED WITH tool_search");
    expect(
      loader.visibleSchemas([{ name: "grep", description: "", parameters: {} }]).map((d) => d.name),
    ).toEqual(["tool_search", "grep"]);
    expect(searchTools("edit, grep", [...tools, grep]).map((t) => t.name)).toEqual([
      "edit",
      "grep",
    ]);
    expect(TOOL_SEARCH_SPEC.parameters[0]?.required).toBe(true);
  });

  it("answers a query for files with the tool that reads them, not a dead end", () => {
    // Suite run 3, card_onyx_4_vault: the Worker asked tool_search for
    // "crypto.js db.js types.js" six times, was told "No tool matches" six
    // times, and was stopped for repeating itself. read_file was loaded all
    // along; the reply never said so. A reply must be completable in one step.
    const loader = new ToolLoader([...tools, grep], ["read_file", "edit"]);
    const r = loader.handle("crypto.js db.js types.js");
    expect(r.text).toMatch(/finds tools, not files/);
    expect(r.text).toContain('read_file(path: "src/crypto.ts")');
    expect(r.text).not.toMatch(/No tool matches/);
  });

  it("answers a query for code symbols by loading read_symbol and naming the calls", () => {
    // Suite run 4, card_chron_ledger: two turns of tool_search for
    // "ChronicleEvent AuditReport openDatabase hashEvent GENESIS_HASH", each
    // told "No tool matches". The file fix did not cover symbols.
    // WL-M2-7: each call is read_symbol's real signature (path and symbol),
    // with the file that declares the symbol, so it can be made as written.
    const readSymbol: ToolInterfaceSpec = {
      name: "read_symbol",
      summary: "Read one named declaration and its body.",
      parameters: [
        { name: "path", type: "string", required: true, description: "Path" },
        { name: "symbol", type: "string", required: true, description: "Declaration name" },
      ],
    };
    const declared: Record<string, string> = {
      ChronicleEvent: "src/types.ts",
      GENESIS_HASH: "src/hasher.ts",
    };
    const loader = new ToolLoader([...tools, grep, readSymbol], ["read_file", "edit"]);
    const r = loader.handle("ChronicleEvent openDatabase GENESIS_HASH", (s) => declared[s]);
    expect(r.loaded).toEqual(["read_symbol"]);
    expect(r.text).toMatch(/finds tools, not code/);
    expect(r.text).toContain(workerCopy.readSymbolCall("src/types.ts", "ChronicleEvent"));
    expect(r.text).toContain('read_symbol(path="src/hasher.ts", symbol="GENESIS_HASH")');
    expect(r.text).toContain(workerCopy.symbolNotDeclared("openDatabase"));
    expect(r.text).not.toMatch(/read_symbol\(name/);
    expect(loader.isLoaded("read_symbol")).toBe(true);

    // A query that also names a tool keeps its symbols (WL-M2-7).
    const mixed = new ToolLoader([...tools, grep, readSymbol], ["read_file", "edit"]);
    const m = mixed.handle("grep ChronicleEvent", (s) => declared[s]);
    expect(m.loaded).toEqual(["grep", "read_symbol"]);
    expect(m.text).toContain("grep(");
    expect(m.text).toContain(workerCopy.readSymbolCall("src/types.ts", "ChronicleEvent"));
  });
});

describe("C3: query-aware line pruning", () => {
  const file = [
    'import { Database } from "node:sqlite";',
    "",
    ...Array.from({ length: 40 }, (_, i) => `const filler${i} = ${i}; // unrelated helper value`),
    "export class Ledger {",
    "  private balance = 0;",
    ...Array.from({ length: 15 }, (_, i) => `  helper${i}() { return ${i}; }`),
    "  record(amount: number): void {",
    "    this.total = undefined;",
    "  }",
    ...Array.from({ length: 30 }, (_, i) => `  other${i}() { return ${i}; }`),
    "}",
  ].join("\n");

  it("keeps the failing line, its enclosing declarations and imports; elides the rest", () => {
    const pinned = linesNamedFor("src/ledger.ts", failure.errorExcerpt);
    expect(pinned).toEqual([61]);
    const r = pruneLines(file, "record amount total", { maxTokens: 150, pinnedLines: [61] });
    expect(r.fits).toBe(true);
    expect(r.text).toContain("this.total = undefined;");
    expect(r.text).toContain("record(amount: number): void {");
    expect(r.text).toContain("export class Ledger {");
    expect(r.text).toContain('import { Database } from "node:sqlite";');
    expect(r.text).toMatch(/lines \d+-\d+ elided/);
    expect(r.elided.length).toBeGreaterThan(0);
    expect(r.keptLines).toBeLessThan(r.totalLines);
    expect(queryTerms("recordAmount total_value")).toEqual(
      new Set(["recordamount", "record", "amount", "total_value", "total", "value"]),
    );
  });

  it("the Worker prompt prunes an oversized scope file around the failure", () => {
    const r = buildWorkerPrompt(
      base({
        budgetTokens: 1300,
        scopeFiles: [{ path: "src/ledger.ts", content: file }],
        gateFailures: [failure],
        goal: "Record amounts in the ledger",
      }),
    );
    expect(r.prompt).toContain("this.total = undefined;");
    expect(r.prompt).toMatch(/elided; read_file that range/);
  });

  it("MS-T7-6: behind its arm, the null baseline drops lines at random instead, keeping the structure", () => {
    const input = base({
      budgetTokens: 1300,
      scopeFiles: [{ path: "src/ledger.ts", content: file }],
      gateFailures: [failure],
      goal: "Record amounts in the ledger",
    });
    const query = buildWorkerPrompt(input);
    const random = buildWorkerPrompt({ ...input, pruneArm: "random" });
    // Off by default: the default is the pruner's prompt.
    expect(buildWorkerPrompt({ ...input, pruneArm: "query" }).prompt).toBe(query.prompt);
    expect(random.prompt).not.toBe(query.prompt);
    // The same structure: pinned line, declarations, markers.
    expect(random.prompt).toContain("this.total = undefined;");
    expect(random.prompt).toContain("export class Ledger {");
    expect(random.prompt).toMatch(/elided; read_file that range/);
    // Reproducible: the seed comes from the card and the file.
    expect(buildWorkerPrompt({ ...input, pruneArm: "random" }).prompt).toBe(random.prompt);
    // The experiment switch selects it when the input names no arm.
    process.env.SEKHEMET_PRUNE = "random";
    try {
      expect(buildWorkerPrompt(input).prompt).toBe(random.prompt);
    } finally {
      Reflect.deleteProperty(process.env, "SEKHEMET_PRUNE");
    }
  });

  it("resolves the arm once per build and keys the determinism check with it (part 2 review)", () => {
    const input = base({
      budgetTokens: 1300,
      scopeFiles: [{ path: "src/ledger.ts", content: file }],
      gateFailures: [failure],
      goal: "Record amounts in the ledger",
    });
    const writes: string[] = [];
    const real = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      buildWorkerPrompt(input);
      process.env.SEKHEMET_PRUNE = "random";
      buildWorkerPrompt(input);
    } finally {
      Reflect.deleteProperty(process.env, "SEKHEMET_PRUNE");
      process.stderr.write = real;
    }
    expect(writes.filter((w) => w.includes("nondeterministic"))).toEqual([]);
  });

  it("mixes the run's seed into the null arm's seed, and keeps the old seed without one", () => {
    const input = base({
      budgetTokens: 1300,
      scopeFiles: [{ path: "src/ledger.ts", content: file }],
      gateFailures: [failure],
      goal: "Record amounts in the ledger",
      pruneArm: "random",
    });
    const unseeded = buildWorkerPrompt(input).prompt;
    const seven = buildWorkerPrompt({ ...input, seed: 7 }).prompt;
    const results = new Set(
      [7, 8, 9, 10, 11].map((seed) => buildWorkerPrompt({ ...input, seed }).prompt),
    );
    expect(buildWorkerPrompt({ ...input, seed: 7 }).prompt).toBe(seven);
    expect(results.size).toBeGreaterThan(1);
    // Without a seed the draw is the card-and-file one it always was.
    expect(buildWorkerPrompt({ ...input }).prompt).toBe(unseeded);
  });
});

describe("the prefix hash covers what was assembled (step 8)", () => {
  it("is stable across two builds of the same card", () => {
    // The reproducibility record used to hash the system-prompt constant,
    // which matched across every card in every repository and so could never
    // detect the drift it existed to catch. The hash must cover the prompt
    // that was actually built.
    const a = buildWorkerPrompt(base());
    const b = buildWorkerPrompt(base());
    expect(a.metrics.prefixHash).toMatch(/^[0-9a-f]{8,}$/);
    expect(b.metrics.prefixHash).toBe(a.metrics.prefixHash);
  });

  it("is shared across cards, which is what makes the cache worth having", () => {
    // Deliberate: the stable prefix carries nothing card-specific, so two
    // cards in one repository reuse the same cached prefill.
    expect(buildWorkerPrompt(base({ card: card(2) })).metrics.prefixHash).toBe(
      buildWorkerPrompt(base()).metrics.prefixHash,
    );
  });

  it("changes when the playbook the model is given changes", () => {
    // The drift a reproducibility record exists to catch: two attempts of
    // one card that were not given the same guidance.
    const withBoth = buildWorkerPrompt(base({ rules: [ruleA, ruleB] }));
    const withOne = buildWorkerPrompt(base({ rules: [ruleA] }));
    expect(withOne.metrics.prefixHash).not.toBe(withBoth.metrics.prefixHash);
  });
});
