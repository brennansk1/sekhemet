import { describe, expect, it } from "vitest";
import {
  ALLOCATOR_WINDOW_MARGIN_TOKENS,
  ContextCapError,
  type ContextSection,
  ROLE_ANSWER_TOKENS,
  allocateContext,
  estimatePromptTokens,
} from "../src/allocator.js";

const words = (n: number, tag: string) =>
  Array.from({ length: n }, (_, i) => `${tag}${i}`).join(" ");

function worker(): ContextSection[] {
  return [
    {
      id: "laws",
      kind: "laws",
      placement: "system",
      order: 0,
      priority: 100,
      required: true,
      text: "LAWS",
    },
    {
      id: "map",
      kind: "repo_map",
      placement: "static",
      order: 0,
      priority: 10,
      text: words(200, "map"),
    },
    {
      id: "test",
      kind: "tests",
      placement: "static",
      order: 10,
      priority: 40,
      text: words(200, "test"),
    },
    {
      id: "ref",
      kind: "other_file",
      placement: "static",
      order: 20,
      priority: 30,
      text: words(200, "ref"),
    },
    {
      id: "old",
      kind: "history_old",
      placement: "volatile",
      order: 300,
      priority: 20,
      text: words(200, "old"),
    },
    {
      id: "scope",
      kind: "scope_file",
      placement: "volatile",
      order: 100,
      priority: 90,
      text: words(200, "scope"),
    },
    {
      id: "fail",
      kind: "failure",
      placement: "volatile",
      order: 400,
      priority: 95,
      text: words(100, "fail"),
    },
    {
      id: "goal",
      kind: "goal",
      placement: "volatile",
      order: 1000,
      priority: 100,
      required: true,
      text: "GOAL",
    },
  ];
}

const size = (ids: string[]) =>
  worker()
    .filter((s) => ids.includes(s.id))
    .reduce((a, s) => a + estimatePromptTokens(s.text) + 1, 0);

describe("allocateContext", () => {
  it("cuts repo map, then old history, then non-scope files, then tests; scope and failure last", () => {
    const keepAll = ["laws", "map", "test", "ref", "old", "scope", "fail", "goal"];
    const dropped = (budget: number) =>
      allocateContext(worker(), { budgetTokens: budget })
        .events.filter((e) => e.action === "dropped")
        .map((e) => e.kind);
    expect(dropped(size(keepAll))).toEqual([]);
    expect(dropped(size(keepAll) - 1)).toEqual(["repo_map"]);
    expect(dropped(size(keepAll.filter((i) => i !== "map")) - 1)).toEqual([
      "repo_map",
      "history_old",
    ]);
    const coreOnly = size(["laws", "scope", "fail", "goal"]);
    const result = allocateContext(worker(), { budgetTokens: coreOnly });
    expect(result.events.filter((e) => e.action === "dropped").map((e) => e.kind)).toEqual([
      "repo_map",
      "history_old",
      "other_file",
      "tests",
    ]);
    expect(result.sections.map((s) => s.id)).toEqual(["laws", "scope", "fail", "goal"]);
    expect(result.fits).toBe(true);
  });

  it("renders system, then static, then volatile, by order", () => {
    const r = allocateContext(worker(), { budgetTokens: 100_000 });
    expect(r.sections.map((s) => s.id)).toEqual([
      "laws",
      "map",
      "test",
      "ref",
      "scope",
      "old",
      "fail",
      "goal",
    ]);
  });

  it("shrinks a section with a minimum instead of dropping it, and never drops a required one", () => {
    const sections = worker().map((s) => (s.id === "scope" ? { ...s, minTokens: 50 } : s));
    const budget = size(["laws", "fail", "goal"]) + 120;
    const r = allocateContext(sections, { budgetTokens: budget });
    const scope = r.sections.find((s) => s.id === "scope");
    expect(scope?.text.endsWith("… (cut to fit the context window)")).toBe(true);
    expect(r.events.find((e) => e.id === "scope")?.action).toBe("shrunk");
    expect(r.usedTokens).toBeLessThanOrEqual(budget);
    const tiny = allocateContext(worker(), { budgetTokens: 1 });
    expect(tiny.sections.map((s) => s.id)).toEqual(["laws", "goal"]);
    expect(tiny.fits).toBe(false);
  });

  it("applies caps, and counts overhead (native tool schemas) against the budget", () => {
    const r = allocateContext(
      [
        {
          id: "plan",
          kind: "plan",
          placement: "static",
          order: 0,
          priority: 65,
          capTokens: 50,
          text: words(300, "p"),
        },
      ],
      { budgetTokens: 1000, overheadTokens: 400 },
    );
    expect(r.events[0]).toMatchObject({ id: "plan", action: "capped" });
    expect(estimatePromptTokens(r.sections[0]?.text ?? "")).toBeLessThanOrEqual(50);
    expect(r.usedTokens).toBe(400 + estimatePromptTokens(r.sections[0]?.text ?? "") + 1);
  });

  it("drops a duplicate by fact key or text, keeping the holder in the earlier placement", () => {
    const r = allocateContext(
      [
        {
          id: "rule",
          kind: "rules",
          placement: "system",
          order: 10,
          priority: 55,
          factKeys: ["exactOptionalPropertyTypes"],
          text: "- rule text",
        },
        {
          id: "remedy",
          kind: "remedy",
          placement: "volatile",
          order: 401,
          priority: 75,
          factKeys: ["exactOptionalPropertyTypes"],
          text: "How to fix: omit it",
        },
        {
          id: "lesson",
          kind: "lessons",
          placement: "volatile",
          order: 0,
          priority: 60,
          inferKeys: true,
          text: "- When you see TS2375 omit the property",
        },
        {
          id: "a",
          kind: "dossier",
          placement: "static",
          order: 1,
          priority: 62,
          text: "Same   answer",
        },
        {
          id: "b",
          kind: "dossier",
          placement: "static",
          order: 2,
          priority: 62,
          text: "same answer",
        },
      ],
      { budgetTokens: 10_000 },
    );
    expect(r.sections.map((s) => s.id)).toEqual(["rule", "a"]);
    // Events come in winner-first order: static before volatile, then priority.
    expect(r.events.map((e) => [e.id, e.action, e.coveredBy])).toEqual([
      ["b", "deduplicated", "a"],
      ["remedy", "deduplicated", "rule"],
      ["lesson", "deduplicated", "rule"],
    ]);
  });
});

describe("CX-N3-1: allocateContext for a role's window", () => {
  it("derives the budget from the role's window less its answer and the margin, and records the role and each section's tokens", () => {
    const r = allocateContext(worker(), {
      role: "planner",
      windowTokens: 8192,
      answerTokens: 2048,
    });
    expect(r.budgetTokens).toBe(8192 - 2048 - ALLOCATOR_WINDOW_MARGIN_TOKENS);
    expect(r.role).toBe("planner");
    expect(r.windowTokens).toBe(8192);
    expect(r.sectionTokens.map((s) => s.id)).toEqual(r.sections.map((s) => s.id));
    expect(r.sectionTokens.reduce((a, s) => a + s.tokens + 1, 0)).toBe(r.usedTokens);
    // Without an explicit answer, the role's default answer cap is reserved.
    const d = allocateContext(worker(), { role: "reviewer", windowTokens: 12_288 });
    expect(d.budgetTokens).toBe(
      12_288 - ROLE_ANSWER_TOKENS.reviewer - ALLOCATOR_WINDOW_MARGIN_TOKENS,
    );
  });

  it("fits a small window by the priorities, the required sections kept", () => {
    const window = size(["laws", "scope", "fail", "goal"]) + 100 + ALLOCATOR_WINDOW_MARGIN_TOKENS;
    const r = allocateContext(worker(), {
      role: "worker",
      windowTokens: window,
      answerTokens: 100,
    });
    expect(r.fits).toBe(true);
    expect(r.sections.map((s) => s.id)).toEqual(["laws", "scope", "fail", "goal"]);
  });

  it("asserts every cap: a shrink that returns more than its cap is refused, naming the section and the role", () => {
    const plan: ContextSection = {
      id: "plan",
      kind: "plan",
      placement: "static",
      order: 0,
      priority: 65,
      capTokens: 20,
      text: words(300, "p"),
      shrink: (t) => t.slice(0, 400),
    };
    expect(() => allocateContext([plan], { role: "seshat", windowTokens: 8192 })).toThrow(
      ContextCapError,
    );
    expect(() => allocateContext([plan], { role: "seshat", windowTokens: 8192 })).toThrow(
      /plan.*seshat|seshat.*plan/,
    );
  });

  it("refuses to allocate with neither a budget nor a window", () => {
    expect(() => allocateContext(worker(), {} as never)).toThrow(/budget|window/);
  });
});
