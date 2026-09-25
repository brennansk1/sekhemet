import { describe, expect, it } from "vitest";
import {
  compareWithBaseline,
  countImperativeRules,
  countNegations,
  countSentences,
  findCapitalEmphasis,
  findContradictions,
  findLongToolDescriptions,
  findPlaceholders,
  lintPrompt,
} from "../src/prompt_lint.js";
import {
  PROMPT_ACRONYM_ALLOWLIST,
  PROMPT_EMPHASIS_WORDS,
  REGISTERED_PROMPT_TAGS,
  isAllowlistedCapitalWord,
  isRegisteredPromptTag,
} from "../src/prompt_tags.js";

// PROMPT_STANDARD rules 5, 10, 11, 12, 18, 35.1 and 36; context CX-M1-12.

describe("the registered vocabulary and allowlist (rules 5 and 10)", () => {
  it("registers the tags the standard names", () => {
    for (const tag of [
      "rules",
      "tool_rules",
      "example",
      "prefer",
      "instead_of",
      "card",
      "criteria",
      "acceptance_test",
      "observation",
      "document",
      "source",
      "content",
      "untrusted_content",
    ]) {
      expect(isRegisteredPromptTag(tag)).toBe(true);
    }
    expect(REGISTERED_PROMPT_TAGS).toHaveLength(13);
    expect(isRegisteredPromptTag("path")).toBe(false);
  });

  it("allows acronyms and error codes but never an emphasis word", () => {
    for (const word of ["JSON", "HTTP", "URL", "API", "SQL", "CLI", "LSP", "TS2375", "TS18048"]) {
      expect(isAllowlistedCapitalWord(word)).toBe(true);
    }
    expect(isAllowlistedCapitalWord("TS12")).toBe(false);
    for (const word of PROMPT_EMPHASIS_WORDS) {
      expect(isAllowlistedCapitalWord(word)).toBe(false);
      expect(PROMPT_ACRONYM_ALLOWLIST).not.toContain(word);
    }
  });
});

describe("capital-letter emphasis (rule 10)", () => {
  it("flags all-capital words of two or more letters", () => {
    expect(findCapitalEmphasis("NEVER modify the test. Do it NOW, I said.")).toEqual([
      "NEVER",
      "NOW",
    ]);
  });

  it("skips allowlisted acronyms, error codes and code spans", () => {
    expect(
      findCapitalEmphasis("Return JSON over HTTP; fix TS2375 in `MAX_LINES` and ```CONST = 1```."),
    ).toEqual([]);
  });

  it("counts each part of a hyphenated capital word", () => {
    expect(findCapitalEmphasis("NON-NEGOTIABLE LAWS")).toEqual(["NON", "NEGOTIABLE", "LAWS"]);
  });
});

describe("imperative rules (rule 11)", () => {
  it("counts the items of the rule sections when the template has them", () => {
    const text = [
      "You fix one card.",
      "<rules>",
      "- Write only the files in scope.",
      "- Call check after each edit.",
      "</rules>",
      "<tool_rules>",
      "1. Read a file before editing it.",
      "</tool_rules>",
      "<example>Call read_file first.</example>",
    ].join("\n");
    expect(countImperativeRules(text)).toEqual({ count: 3, method: "rule_sections" });
  });

  it("counts directive sentences in a legacy template, documented as such", () => {
    const text = [
      "You are the planner.",
      "Rules:",
      "1. State the root cause in one sentence. Give the fix as steps.",
      "2. SCOPE DISCIPLINE: Touch only declared scope files.",
      "The worker is small.",
      "Never change a test.",
      "You never change the board yourself.",
    ].join("\n");
    expect(countImperativeRules(text)).toEqual({ count: 5, method: "legacy_directives" });
  });
});

describe("negations", () => {
  it("counts negating words outside code spans", () => {
    expect(countNegations("Do not guess. No other tool exists; never retry. It can't. `not`")).toBe(
      4,
    );
  });
});

describe("placeholders (rule 5, CX-M1-12)", () => {
  it("allows registered tags, opening or closing, with or without attributes", () => {
    expect(
      findPlaceholders(
        '<card>x</card> <observation>y</observation> <untrusted_content source="web">z</untrusted_content>',
      ),
    ).toEqual([]);
  });

  it("flags unregistered lower-case spans in angle or square brackets", () => {
    expect(findPlaceholders("code: <file name> then <path> and [your answer].")).toEqual([
      "<file name>",
      "<path>",
      "[your answer]",
    ]);
  });

  it("does not flag comparisons, capitalised labels or spans with digits", () => {
    expect(findPlaceholders("x < 5 and y > 3; [Split] [Dismiss]; [120 chars omitted]")).toEqual([]);
  });
});

describe("tool descriptions (rule 18)", () => {
  it("counts sentences, ignoring abbreviations and code spans", () => {
    expect(countSentences("Read a file, e.g. `a.ts`. Read before you edit.")).toBe(2);
    expect(countSentences("One. Two. Three.")).toBe(3);
  });

  it("names every description longer than two sentences", () => {
    expect(
      findLongToolDescriptions([
        { name: "read_file", description: "Read a file. Read before you edit." },
        { name: "grep", description: "Search. Use it often. Prefer it to run_cmd." },
      ]),
    ).toEqual(["grep (3 sentences)"]);
  });
});

describe("contradictions (rule 12, CX-M1-1)", () => {
  it("finds 'no other tool exists' while an unlisted tool is callable", () => {
    const text = "Tools: read_file, edit. Call only the tools named below. No other tool exists.";
    expect(findContradictions(text, { callableTools: ["read_file", "edit"] })).toEqual([]);
    expect(findContradictions(text, { callableTools: ["read_file", "edit", "recall"] })).toEqual([
      '"No other tool exists" while recall is callable and not listed',
    ]);
  });

  it("finds 'several calls' beside 'exactly one tool call'", () => {
    expect(
      findContradictions("You may emit several calls in one step. Emit exactly one tool call now."),
    ).toEqual(['both "several calls" and "exactly one tool call"']);
  });

  it("finds a do-not-re-read marker beside an instruction to re-read", () => {
    expect(
      findContradictions(
        "SCOPE FILE: a.ts (current content; edit it, do not read_file it)\nOtherwise read the file and correct it.",
      ),
    ).toEqual(['a "do not re-read" marker beside an instruction to read the file again']);
  });

  it("finds an observation pointer while recall is not offered", () => {
    const text = "Turn 1: read_file -> EvidenceRef: ev_1";
    expect(findContradictions(text, { callableTools: ["read_file", "recall"] })).toEqual([]);
    expect(findContradictions(text, { callableTools: ["read_file"] })).toEqual([
      "an observation pointer while recall is not offered",
    ]);
  });

  it("finds double numbering and the banned strings", () => {
    expect(findContradictions("1. 1. First\nPreserved in WAL.\nNON-NEGOTIABLE LAWS:")).toEqual([
      "a list item numbered twice",
      'the string "WAL"',
      'the string "NON-NEGOTIABLE"',
    ]);
  });
});

describe("lintPrompt", () => {
  it("reports every count and finding for one template", () => {
    const report = lintPrompt("IMPORTANT: do not guess. Use <path>.", {
      tools: [{ name: "a", description: "One. Two. Three." }],
    });
    expect(report.counts).toEqual({
      capitalWords: 1,
      imperativeRules: 2,
      negations: 1,
      longToolDescriptions: 1,
    });
    expect(report.ruleCountMethod).toBe("legacy_directives");
    expect(report.capitalWords).toEqual(["IMPORTANT"]);
    expect(report.placeholders).toEqual(["<path>"]);
  });
});

describe("the per-template baseline (rule 36)", () => {
  const counts = { capitalWords: 2, imperativeRules: 5, negations: 3, longToolDescriptions: 0 };
  const baseline = {
    "worker.system": { ...counts, ruleCountMethod: "legacy_directives" as const },
  };

  it("passes when no count rises, and when one is lowered", () => {
    expect(
      compareWithBaseline(
        { "worker.system": { ...counts, ruleCountMethod: "legacy_directives" } },
        baseline,
      ),
    ).toEqual([]);
    expect(
      compareWithBaseline(
        { "worker.system": { ...counts, negations: 1, ruleCountMethod: "legacy_directives" } },
        baseline,
      ),
    ).toEqual([]);
  });

  it("fails when a count rises", () => {
    expect(
      compareWithBaseline(
        { "worker.system": { ...counts, capitalWords: 3, ruleCountMethod: "legacy_directives" } },
        baseline,
      ),
    ).toEqual(["worker.system: capitalWords rose from 2 to 3"]);
  });

  it("fails on a template with no recorded baseline and on a stale entry", () => {
    expect(
      compareWithBaseline(
        { "seshat.new": { ...counts, ruleCountMethod: "rule_sections" } },
        baseline,
      ),
    ).toEqual([
      "seshat.new: no recorded baseline; record it (rule 36)",
      "worker.system: recorded but no longer rendered; remove it from the baseline",
    ]);
  });

  it("holds a template in rule-section form to the cap of 12 whatever its baseline", () => {
    expect(
      compareWithBaseline(
        { "worker.system": { ...counts, imperativeRules: 13, ruleCountMethod: "rule_sections" } },
        { "worker.system": { ...counts, imperativeRules: 13, ruleCountMethod: "rule_sections" } },
      ),
    ).toEqual(["worker.system: 13 imperative rules, over the cap of 12 (rule 11)"]);
  });
});
