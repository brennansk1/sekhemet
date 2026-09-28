import { describe, expect, it } from "vitest";
import { DESIGN_COPY } from "../src/design_copy.js";
import {
  type DesignQuestion,
  changesCards,
  designStage,
  renderBrief,
} from "../src/design_stage.js";

/**
 * The design stage is proportional (design: "Most work needs almost none of
 * this"). Before it existed, the planner treated these three specs the same
 * way, and turned the billing service's "fast", "secure" and "scale to many
 * users" into three "happy path" cards.
 */
const BILLING =
  "a billing service that charges customers monthly, handles refunds, and emails invoices; it should be fast and secure and scale to many users";

describe("the design stage", () => {
  it("says nothing for a small change to an existing project", () => {
    const d = designStage("add a --verbose flag to the CLI", { greenfield: false });
    expect(d.proportion).toBe("none");
    expect(d.say).toEqual([]);
  });

  it("says one sentence for a calculator, and records its default", () => {
    const d = designStage("build me a calculator", { greenfield: true });
    expect(d.proportion).toBe("sentence");
    expect(d.say).toHaveLength(1);
    expect(d.say[0]).toMatch(/^Building a calculator\./);
    expect(d.assumptions.some((a) => /TypeScript/.test(a))).toBe(true);
    expect(d.questions).toEqual([]);
  });

  it("asks one or two questions about things hard to change later, and proceeds anyway", () => {
    const d = designStage("a CLI that syncs my notes to S3", { greenfield: true });
    expect(d.proportion).toBe("questions");
    expect(d.questions.length).toBeGreaterThanOrEqual(1);
    expect(d.questions.length).toBeLessThanOrEqual(2);
    for (const q of d.questions) expect(q.default).not.toBe("");
    expect(d.say.join("\n")).toMatch(/Proceeding on the defaults/);
  });

  it("writes a brief for a service that moves money, and names its riskiest assumption", () => {
    const d = designStage(BILLING, { greenfield: true });
    expect(d.proportion).toBe("brief");
    expect(d.riskiest).toMatch(/twice/);
    const brief = renderBrief(d, { gates: ["typecheck", "lint", "test"] });
    for (const section of [
      "## Problem",
      "## Outcome",
      "## Non-goals",
      "## Constraints",
      "## Prior art",
      "## Riskiest assumption",
      "## The first slice",
      "## Definition of done",
      "## Invariants",
    ]) {
      expect(brief).toContain(section);
    }
  });

  it("turns quality words into constraints with defaults, not into cards", () => {
    const d = designStage(BILLING, { greenfield: true });
    expect(d.buildSpec).not.toMatch(/fast|secure|scale/i);
    expect(d.buildSpec).toMatch(/charges customers monthly/);
    expect(d.buildSpec).toMatch(/refunds/);
    expect(d.buildSpec).toMatch(/invoices/);
    const constraints = d.constraints.map((c) => c.quality);
    expect(constraints).toEqual(["fast", "secure", "scale to many users"]);
    for (const c of d.constraints) expect(c.default.length).toBeGreaterThan(10);
  });

  it("drops the request phrasing from what gets built", () => {
    expect(designStage("build me a calculator", { greenfield: true }).buildSpec).toBe(
      "a calculator",
    );
    expect(designStage("I want a todo app", { greenfield: true }).buildSpec).toBe("a todo app");
  });
});

// NEW-design-stage-1 (DS-N1-1…8) and DS-P14-8: the design stage's judgement.
const FORBIDDEN = /\brequirements\b|\bphase\b|let me gather/i;

describe("design-stage judgement (NEW-design-stage-1)", () => {
  it("DS-N1-1: a charging status, author pages, a password generator or a health check is not a brief", () => {
    for (const spec of [
      "a CLI that shows my laptop charging status",
      "a static blog with author pages",
      "a password generator CLI",
      "a health check endpoint",
    ]) {
      const d = designStage(spec, { greenfield: true });
      expect(d.proportion, spec).not.toBe("brief");
      expect(d.riskiest, spec).toBeUndefined();
    }
  });

  it("DS-N1-2: people signing up is a brief with an identity riskiest assumption", () => {
    const d = designStage("a recipe website where people can sign up and save favourites", {
      greenfield: true,
    });
    expect(d.proportion).toBe("brief");
    expect(d.riskiest).toMatch(/right person/);
  });

  it("DS-N1-3: a calculator asks nothing and names the four operations in one sentence", () => {
    const d = designStage("build me a calculator", { greenfield: true });
    expect(d.questions).toEqual([]);
    expect(d.say).toHaveLength(1);
    for (const op of ["add", "subtract", "multiply", "divide"]) expect(d.say[0]).toContain(op);
  });

  it("DS-N1-4: the brief level asks first the question that most changes the cards, with its default", () => {
    const d = designStage(BILLING, { greenfield: true });
    expect(d.proportion).toBe("brief");
    const first = d.questions[0];
    expect(first).toBeDefined();
    expect(first?.default).not.toBe("");
    expect(d.questions.length).toBeLessThanOrEqual(2);
    // Ranked: no later question changes more cards than the first.
    for (const q of d.questions) {
      expect(cardOutcomes(q)).toBeLessThanOrEqual(cardOutcomes(first as DesignQuestion));
    }
    const said = d.say.join("\n");
    expect(said).toContain(first?.question);
    expect(said).toContain(first?.default);
    // One at a time: the second question is not put to the person yet.
    if (d.questions[1]) expect(said).not.toContain(d.questions[1].question);
    // Planning proceeds on the default meanwhile: it is an assumption.
    expect(d.assumptions.some((a) => a.includes(first?.default as string))).toBe(true);
  });

  it("DS-N1-5: a Python script is planned in Python, never assumed TypeScript", () => {
    const d = designStage("a Python script that renames photos", { greenfield: true });
    expect(d.stack.language).toBe("python");
    expect(d.stack.stated).toBe(true);
    const shown = [...d.say, ...d.assumptions].join("\n");
    expect(shown).toMatch(/Python/);
    expect(shown).not.toMatch(/TypeScript|Node|Vitest/);
    expect(designStage("build me a calculator", { greenfield: true }).stack).toMatchObject({
      language: "typescript",
      stated: false,
    });
  });

  it("DS-N1-6: a sentence after a quality word stays in the spec as a hard invariant", () => {
    const d = designStage(
      "a billing service that charges customers monthly; it should be fast and scale to many users. A retried charge must never charge a customer twice.",
      { greenfield: true },
    );
    expect(d.buildSpec).toContain("A retried charge must never charge a customer twice");
    expect(d.invariants).toEqual(["A retried charge must never charge a customer twice."]);
    expect(d.constraints.map((c) => c.quality)).toEqual(["fast", "scale to many users"]);
    const brief = renderBrief(d, { gates: ["test"] });
    expect(brief).toContain("A retried charge must never charge a customer twice");
  });

  it("DS-N1-7: nothing shown says requirements, phase or let me gather", () => {
    for (const spec of [
      "add a --verbose flag to the CLI",
      "build me a calculator",
      "a CLI that syncs my notes to S3",
      BILLING,
      "a recipe website where people can sign up and save favourites",
      "a patient records service for a clinic",
    ]) {
      const d = designStage(spec, { greenfield: true });
      expect(d.say.join("\n"), spec).not.toMatch(FORBIDDEN);
      expect(renderBrief(d, { gates: ["test"] }), spec).not.toMatch(FORBIDDEN);
    }
    for (const text of allCopyText()) expect(text).not.toMatch(FORBIDDEN);
  });

  it("DEC-31: the brief, what Seshat says and the project's Type use the words teams use", () => {
    // A payment card is a card; every other card is an issue (DEC-31, NAMING). A file
    // name (gates.toml) is not a word a person reads.
    const RETIRED =
      /must-haves?|nice-to-haves?|\bkano\b|\bgates?\b(?!\.toml)|\bcards?\b(?!\s+(?:numbers?|details|data|entry))|\bworkers?\b|\bplanners?\b|\bresearcher\b/i;
    for (const spec of [
      "build me a calculator",
      "a CLI that syncs my notes to S3",
      BILLING,
      "a recipe website where people can sign up and save favourites",
      "a patient records service for a clinic",
    ]) {
      const d = designStage(spec, { greenfield: true });
      expect(d.say.join("\n"), spec).not.toMatch(RETIRED);
      expect(renderBrief(d, { gates: [] }), spec).not.toMatch(RETIRED);
    }
    // The Type's reason, read on Review plan under *Proposed:*.
    for (const reason of Object.values(DESIGN_COPY.depth)) {
      const text = typeof reason === "function" ? reason("health records") : reason;
      expect(text).not.toMatch(RETIRED);
    }
  });

  it("DS-N1-8: with no non-goals given, the brief says Not stated — assumed:, from what was said", () => {
    const d = designStage("a recipe website where people can sign up and save favourites", {
      greenfield: true,
    });
    const brief = renderBrief(d, { gates: ["test"] });
    const nonGoals = section(brief, "Non-goals");
    expect(nonGoals).toMatch(/Not stated — assumed:/);
    expect(nonGoals).not.toMatch(/Anything else is a new card/);
    // Problem and Outcome are written from the request, not a template.
    expect(section(brief, "Problem")).toMatch(/people/);
    expect(section(brief, "Outcome")).toMatch(/sign up/);
    expect(section(brief, "Outcome")).toMatch(/save favourites/);
  });

  it("DS-N1-6, DS-N1-8: a hard rule that starts with No or Not stays a rule, not a non-goal", () => {
    const d = designStage(
      "Build a billing service that charges customers monthly. No customer may ever be charged twice and every refund must always be logged.",
      { greenfield: true },
    );
    expect(d.nonGoals).toEqual([]);
    expect(d.invariants).toEqual([
      "No customer may ever be charged twice and every refund must always be logged.",
    ]);
    expect(d.buildSpec).toContain("No customer may ever be charged twice");
    const alone = designStage("A billing service. No customer can be charged twice.", {
      greenfield: true,
    });
    expect(alone.nonGoals).toEqual([]);
    expect(alone.invariants).toEqual(["No customer can be charged twice."]);
    expect(alone.buildSpec).toContain("No customer can be charged twice");
    // A thing left out is still a non-goal.
    expect(designStage(`${BILLING}; no mobile app`, { greenfield: true }).nonGoals).toEqual([
      "mobile app",
    ]);
    expect(
      designStage(`${BILLING}. Not a customer portal.`, { greenfield: true }).nonGoals,
    ).toEqual(["a customer portal"]);
  });

  it("DS-N1-8: non-goals the person gave are written as theirs", () => {
    const d = designStage(`${BILLING}, without a customer portal`, { greenfield: true });
    expect(d.nonGoals).toEqual(["a customer portal"]);
    const nonGoals = section(renderBrief(d, { gates: ["test"] }), "Non-goals");
    expect(nonGoals).toContain("a customer portal");
    expect(nonGoals).not.toMatch(/Not stated/);
    expect(d.buildSpec).not.toMatch(/portal/);
  });
});

describe("DS-P14-8: a question is asked only when its answers change the cards", () => {
  it("every question asked has two answers that produce different cards, and a default", () => {
    for (const spec of [
      "a CLI that syncs my notes to S3",
      BILLING,
      "a recipe website where people can sign up and save favourites",
      "an HTTP API over a database of books",
    ]) {
      for (const q of designStage(spec, { greenfield: true }).questions) {
        expect(changesCards(q), `${spec}: ${q.question}`).toBe(true);
        expect(q.default).toBe(q.answers[0]?.answer);
      }
    }
  });

  it("a question the request already settles is not asked", () => {
    const d = designStage("a notes CLI that keeps everything in SQLite", { greenfield: true });
    expect(d.questions.map((q) => q.question)).not.toContain("Which database?");
  });

  it("a question whose answers give the same cards is not a question", () => {
    expect(
      changesCards({
        question: "Tabs or spaces?",
        default: "spaces",
        answers: [
          { answer: "spaces", cards: ["Format the code"] },
          { answer: "tabs", cards: ["Format the code"] },
        ],
      }),
    ).toBe(false);
  });
});

function section(brief: string, name: string): string {
  const start = brief.indexOf(`## ${name}`);
  const rest = brief.slice(start + name.length + 3);
  const end = rest.indexOf("\n## ");
  return end === -1 ? rest : rest.slice(0, end);
}

const cardOutcomes = (q: DesignQuestion) => new Set(q.answers.map((a) => a.cards.join("|"))).size;

function allCopyText(): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") out.push(v);
    else if (typeof v === "function") return;
    else if (v instanceof RegExp) return;
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(DESIGN_COPY);
  return out;
}
