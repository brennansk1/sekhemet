import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { GateFailure } from "@sekhemet/gates";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import type { InferenceRequest, InferenceResponse, LocalInferenceAdapter } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import { projectStack, repairQuestion, researchBeforeRepair } from "../src/research/repair.js";
import { ResearchMemory, ResearchService } from "../src/research/service.js";

/**
 * Design-stage NEW-design-stage-5: the Researcher asked early, with the card
 * in hand. Real repositories on disk, a real card store; a scripted model.
 */
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const repo = (files: Record<string, string>) => {
  const d = mkdtempSync(join(tmpdir(), "repair-"));
  dirs.push(d);
  for (const [f, body] of Object.entries(files)) writeFileSync(join(d, f), body);
  return d;
};

const failure: GateFailure = {
  gate: "test",
  rung: "test",
  layer: "functional",
  exitCode: 1,
  errorExcerpt: "AssertionError: expected 3 to be 4",
  suggestedFixFiles: ["src/sum.py"],
  location: { file: "tests/test_sum.py", line: 12 },
  expected: "sum([1, 3]) == 4",
  actual: "AssertionError: expected 3 to be 4",
  minimalRepro: "python3 -m pytest tests/test_sum.py::test_sum",
  suggestedAction: "fix it",
};

const card = {
  id: "card_s",
  title: "Sum a list",
  spec: "Add sum(xs) that returns the total of a list of integers.",
  acceptanceCriteria: ["WHEN sum is given [1, 3] THE SYSTEM SHALL return 4"],
  scopeFiles: ["src/sum.py", "tests/test_sum.py"],
} as never;

describe("the question carries the card and the detected stack (DS-N5-1)", () => {
  it("names the stack from the manifests, never a hard-coded language", () => {
    expect(projectStack(repo({ "pyproject.toml": "[project]\nname='x'\n" }))).toBe("Python");
    expect(projectStack(repo({ "package.json": "{}", "tsconfig.json": "{}" }))).toMatch(
      /^TypeScript \(Node\.js, /,
    );
    expect(projectStack(repo({ "go.mod": "module x\n" }))).toBe("Go");
    expect(projectStack(repo({}))).toBe("unknown-stack");
  });

  it("passes the spec, criteria, scope files, the typed failure and the stack", () => {
    const q = repairQuestion({ card, failures: [failure], struggle: "kept off by one" }, "Python");
    expect(q).toContain("a Python project");
    expect(q).not.toMatch(/TypeScript/);
    expect(q).toContain("Add sum(xs) that returns the total of a list of integers.");
    expect(q).toContain("1. WHEN sum is given [1, 3] THE SYSTEM SHALL return 4");
    expect(q).toContain("src/sum.py\ntests/test_sum.py");
    expect(q).toContain("gate: test (functional)");
    expect(q).toContain("location: tests/test_sum.py:12");
    expect(q).toContain("expected: sum([1, 3]) == 4");
    expect(q).toContain("reproduce: python3 -m pytest tests/test_sum.py::test_sum");
    expect(q).toContain("kept off by one");
  });
});

describe("the repair question stays private (DS-N5-1)", () => {
  it("redacts a secret from the card and the gate's output before the Researcher sees it", () => {
    const key = "AKIAIOSFODNN7EXAMPLE";
    const leaky = {
      ...failure,
      actual: `ConnectionError: login with ${key} refused`,
      errorExcerpt: `ConnectionError: login with ${key} refused`,
    };
    const q = repairQuestion(
      { card: { ...(card as object), spec: `Use the key ${key}.` } as never, failures: [leaky] },
      "Python",
    );
    expect(q).not.toContain(key);
    expect(q).toContain("ConnectionError: login with");
  });

  it("is asked only of a Researcher on this machine, never a remote server", async () => {
    const root = repo({});
    let called = 0;
    const remote: LocalInferenceAdapter = {
      modelId: "generic-researcher",
      supportedArms: ["arm_a_flat"],
      remote: true,
      async generate() {
        called++;
        return {
          text: "x",
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
        };
      },
    };
    const service = new ResearchService({
      repoPath: root,
      memory: new ResearchMemory(join(root, "mem.jsonl")),
      model: async () => remote,
    });
    await expect(
      service.ask("Why does the card fail?", { localOnly: true, fresh: true }),
    ).rejects.toThrow(/this machine/);
    expect(called).toBe(0);
  });
});

describe("research first, the answer whole on the card's dossier (DS-N5-2, DS-N5-3)", () => {
  it("asks once per failing card before any plan, keeps only grounded answers, and stores each whole", async () => {
    const root = repo({ "pyproject.toml": "[project]\nname='x'\n" });
    mkdirSync(join(root, ".sekhemet"), { recursive: true });
    const db = new DatabaseSync(join(root, ".sekhemet", "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    const cards = new CardStore(db, log);
    await cards.createCard({
      id: "card_s",
      tier: "task",
      title: "Sum a list",
      spec: "Add sum(xs).",
      status: "ready",
    });
    const long = `Use the built-in sum() [1]. ${"It adds the items of an iterable from left to right. ".repeat(40)}`;
    const asked: InferenceRequest[] = [];
    const steps: Partial<InferenceResponse>[] = [
      { toolCalls: [{ id: "c1", name: "package_readme", arguments: { name: "sum" } }] },
      { text: long.trim() },
    ];
    let i = 0;
    const model: LocalInferenceAdapter = {
      modelId: "generic-researcher",
      supportedArms: ["arm_a_flat"],
      nativeTools: true,
      contextWindow: { contextTokens: 16384, maxTokens: 1500 },
      async generate(req) {
        asked.push(req);
        return {
          text: "",
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
          ...(steps[Math.min(i++, steps.length - 1)] ?? {}),
        };
      },
    };
    const service = new ResearchService({
      repoPath: root,
      cardStore: cards,
      log,
      memory: new ResearchMemory(join(root, "mem.jsonl")),
      tools: { fetchJson: async () => ({ readme: "sum docs", license: "MIT" }) },
      model: async () => model,
    });
    const order: string[] = [];
    const out = await researchBeforeRepair(
      root,
      [
        {
          card: (await cards.getCard("card_s")) as never,
          failures: [failure],
          struggle: "off by one",
        },
      ],
      async (q, cardId) => {
        order.push("research");
        return service.ask(q, { cardId });
      },
    );
    order.push("plan");
    expect(order).toEqual(["research", "plan"]);
    expect(out.get("card_s")?.answer).toBe(long.trim());
    expect(String(asked[0]?.messages?.[0]?.content)).toContain("a Python project");
    const [entry] = await log.getEventsByTypes(["card/research"]);
    expect(entry?.cardId).toBe("card_s");
    const text = (entry?.payload as { text: string }).text;
    expect(text).toContain(long.trim());
    expect(text.length).toBeGreaterThan(1500);
    db.close();
  });
});
