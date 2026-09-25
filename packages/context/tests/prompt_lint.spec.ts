import { describe, expect, it } from "vitest";
import {
  PROMPT_LINT_MEASURE_VERSION,
  type PromptLintBaselineFile,
  baselineEntryOf,
  baselineTotals,
  compareWithBaseline,
  countImperativeRules,
  countNegations,
  countSentences,
  findCapitalEmphasis,
  findContradictions,
  findLongToolDescriptions,
  findPlaceholders,
  lintPrompt,
  lowerBaseline,
  nextBaselineFile,
  parseBaselineRenames,
} from "../src/prompt_lint.js";
import {
  COPY_MODULES,
  PROMPT_ACRONYM_ALLOWLIST,
  PROMPT_EMPHASIS_WORDS,
  REGISTERED_PROMPT_TAGS,
  isAllowlistedCapitalWord,
  isCopyModulePath,
  isRegisteredPromptTag,
  unregisteredCopyModules,
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
    for (const word of ["ALWAYS", "ONLY", "NOT", "DO", "NOTE", "WARNING"]) {
      expect(PROMPT_EMPHASIS_WORDS).toContain(word);
    }
    for (const word of PROMPT_EMPHASIS_WORDS) {
      expect(isAllowlistedCapitalWord(word)).toBe(false);
      expect(PROMPT_ACRONYM_ALLOWLIST).not.toContain(word);
    }
  });
});

describe("copy modules (rule 13, CX-M1-13)", () => {
  it("exempts only a registered copy module, by role", () => {
    expect(COPY_MODULES.gates).toBe("packages/gates/src/copy.ts");
    expect(COPY_MODULES.worker).toBe("packages/context/src/worker_copy.ts");
    expect(isCopyModulePath("packages/gates/src/copy.ts")).toBe(true);
    expect(isCopyModulePath("packages/loop/src/worker_copy.ts")).toBe(false);
    expect(isCopyModulePath("packages/loop/src/copy.ts")).toBe(false);
  });

  it("names a file shaped like a copy module that is not registered", () => {
    expect(
      unregisteredCopyModules([
        "packages/gates/src/copy.ts",
        "packages/loop/src/worker_copy.ts",
        "apps/harness/src/copy/pm.ts",
        "packages/loop/src/tools.ts",
      ]),
    ).toEqual(["packages/loop/src/worker_copy.ts", "apps/harness/src/copy/pm.ts"]);
  });

  it("does not ask a package whose copy only people read to register it", () => {
    expect(
      unregisteredCopyModules(["packages/ui/src/copy.ts", "packages/ui/src/board_copy.ts"]),
    ).toEqual([]);
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

  it("still flags an emphasis word inside an inline code span, not in fenced code", () => {
    expect(findCapitalEmphasis("Reply with `NEVER` and ```MUST``` and `MAX_LINES`.")).toEqual([
      "NEVER",
    ]);
  });

  it("does not check fenced code or the bodies of data tags", () => {
    const text = [
      "Query the table.",
      "```sql\nSELECT * FROM t WHERE id IS NOT NULL -- NOTE: fast\nlog.WARNING(x)\n```",
      '<untrusted_content source="web">MAX_ROWS is 5; ENOENT raised</untrusted_content>',
      "<document>README: DO NOT EDIT</document>",
      "<observation>TODO fixed</observation>",
      "<acceptance_test>expect(MAX).toBe(1)</acceptance_test>",
      "<content>ALL CAPS DATA</content>",
    ].join("\n");
    expect(findCapitalEmphasis(text)).toEqual([]);
  });

  it("does not count a date or time format such as YYYY-MM-DD", () => {
    expect(findCapitalEmphasis("A date as YYYY-MM-DD, a time as HH:MM:SS.")).toEqual([]);
    expect(findCapitalEmphasis("DD this now")).toEqual(["DD"]);
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
    expect(countImperativeRules(text)).toEqual({
      count: 3,
      method: "rule_sections",
      violations: [],
    });
  });

  it("counts each directive sentence of an item, and unlisted lines inside a section", () => {
    const text = [
      "<rules>",
      "- Write only the files in scope. Call check after each edit. Stop when it passes.",
      "- Keep functions small.",
      "Never edit a test.",
      "</rules>",
    ].join("\n");
    expect(countImperativeRules(text)).toEqual({
      count: 5,
      method: "rule_sections",
      violations: [],
    });
  });

  it("counts every sentence of a rule-section line, whatever its first word", () => {
    const rules = (body: string) => countImperativeRules(`<rules>\n${body}\n</rules>`).count;
    expect(
      rules("- If it fails, run check. If it passes, stop. When done, call finish_card."),
    ).toBe(3);
    expect(rules("- Be brief. Be exact.")).toBe(2);
    expect(rules("- Scope: Read X. Write Y.")).toBe(2);
    expect(rules("- Don’t edit tests. Don’t edit fixtures.")).toBe(2);
    expect(rules("- Keep it short")).toBe(1);
  });

  it("counts a curly-apostrophe negation as a directive in a legacy template", () => {
    expect(countImperativeRules("Don’t edit tests.").count).toBe(1);
  });

  it("accepts attributes on a rule section", () => {
    const text = '<rules scope="card">\n- Write only the files in scope.\n</rules>';
    expect(countImperativeRules(text)).toEqual({
      count: 1,
      method: "rule_sections",
      violations: [],
    });
  });

  it("treats an empty rule section beside directives elsewhere as a violation", () => {
    const text = "<rules></rules>\nNever edit a test. Call check after each edit.";
    const report = lintPrompt(text);
    expect(report.ruleCountMethod).toBe("rule_sections");
    expect(report.ruleViolations).toEqual([
      "the rule sections are empty while 2 directives sit outside them (rule 11)",
    ]);
    expect(
      lintPrompt("<rules>\n- Call check.\n</rules>\nNever edit a test.").ruleViolations,
    ).toEqual([]);
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
    expect(countImperativeRules(text)).toEqual({
      count: 5,
      method: "legacy_directives",
      violations: [],
    });
  });
});

describe("negations", () => {
  it("counts negating words outside code spans", () => {
    expect(countNegations("Do not guess. No other tool exists; never retry. It can't. `not`")).toBe(
      4,
    );
  });

  it("counts a contraction written with a typographic apostrophe", () => {
    expect(countNegations("It can’t, and it won’t.")).toBe(2);
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

  it("does not flag type arguments or index expressions after an identifier", () => {
    expect(findPlaceholders("a Map<string, number> and rows[index] and Array<entry>")).toEqual([]);
  });

  it("flags a placeholder after an underscore, as in a file name", () => {
    expect(findPlaceholders("write tests/test_<name>.ts")).toEqual(["<name>"]);
  });

  it("allows self-closing and single-quoted registered tags", () => {
    expect(
      findPlaceholders("<example /> <card/> <untrusted_content source='web'>x</untrusted_content>"),
    ).toEqual([]);
    expect(findPlaceholders("<foo a='b' />")).toEqual(["<foo a='b' />"]);
  });

  it("flags a placeholder written with a typographic apostrophe", () => {
    expect(findPlaceholders("<the user’s answer>")).toEqual(["<the user’s answer>"]);
  });

  it("does not check the bodies of data tags", () => {
    expect(
      findPlaceholders(
        "<observation>[warn] a '[number, string]' tuple</observation> <document>[x] [a-z]</document> [your answer]",
      ),
    ).toEqual(["[your answer]"]);
  });

  it("flags placeholders with dots, colons, digits after the first letter, or an ellipsis", () => {
    expect(findPlaceholders("at <file:line> in <path/to/file.ts>: <your answer…> [step2]")).toEqual(
      ["<file:line>", "<path/to/file.ts>", "<your answer…>", "[step2]"],
    );
  });

  it("does not flag a bare URL in angle brackets", () => {
    expect(findPlaceholders("see <https://nodejs.org/api/sqlite.html>")).toEqual([]);
  });

  it("flags an unregistered tag with attributes, and allows a registered one", () => {
    expect(findPlaceholders('<foo a="b">x</foo> <card id="c1">y</card>')).toEqual([
      '<foo a="b">',
      "</foo>",
    ]);
  });

  it("counts lower-case data labels such as [typecheck] as placeholders (context.md CX-M1-12)", () => {
    expect(findPlaceholders("[typecheck] failed; [context compacted]")).toEqual([
      "[typecheck]",
      "[context compacted]",
    ]);
  });
});

describe("tool descriptions (rule 18)", () => {
  it("counts sentences, ignoring abbreviations and code spans", () => {
    expect(countSentences("Read a file, e.g. `a.ts`. Read before you edit.")).toBe(2);
    expect(countSentences("One. Two. Three.")).toBe(3);
  });

  it("names a parameter description longer than two sentences", () => {
    expect(
      findLongToolDescriptions([
        {
          name: "edit",
          description: "Replace text.",
          parameters: [
            { name: "search", description: "Exact text. It must occur once. Copy it." },
            { name: "replace", description: "Replacement text." },
          ],
        },
      ]),
    ).toEqual(["edit.search (3 sentences)"]);
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

  it("finds the repair ladder's re-read instruction beside the scope-file marker", () => {
    expect(
      findContradictions(
        "=== SCOPE FILE: a.ts (current content; edit it, do not read_file it) ===\nRe-read the relevant files from disk before editing.",
      ),
    ).toEqual(['a "do not re-read" marker beside an instruction to read the file again']);
    // The marker alone, however it is written, is not a contradiction.
    expect(
      findContradictions("edit it, do not read_file it\nread src/a.ts (do not re-read)"),
    ).toEqual([]);
  });

  it('treats "don\'t re-read" as a marker too', () => {
    expect(findContradictions("a.ts (don't re-read)\nRe-read the file first.")).toEqual([
      'a "do not re-read" marker beside an instruction to read the file again',
    ]);
    expect(findContradictions("a.ts (don’t re-read it)")).toEqual([]);
  });

  it("does not check the bodies of data tags", () => {
    expect(findContradictions("<card>Preserved in WAL mode.</card>")).toEqual(['the string "WAL"']);
    expect(findContradictions("<document>Preserved in WAL mode.</document>")).toEqual([]);
  });

  it("finds an observation pointer while recall is not offered", () => {
    const text = "Turn 1: read_file -> EvidenceRef: ev_1";
    expect(findContradictions(text, { callableTools: ["read_file", "recall"] })).toEqual([]);
    expect(findContradictions(text, { callableTools: ["read_file"] })).toEqual([
      "an observation pointer while recall is not offered",
    ]);
  });

  it("finds a numbered item under a bullet as numbered twice", () => {
    expect(findContradictions("- 1. append adds one entry")).toEqual([
      "a list item numbered twice",
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

  it("records a legacy template's rule count as not measured, and a rule-section one's count", () => {
    expect(baselineEntryOf(lintPrompt("Never guess. Call check.")).imperativeRules).toBeNull();
    expect(baselineEntryOf(lintPrompt("<rules>\n- Call check.\n</rules>")).imperativeRules).toBe(1);
    // Not measured is not compared.
    const legacy = {
      ...counts,
      imperativeRules: null,
      ruleCountMethod: "legacy_directives" as const,
    };
    expect(compareWithBaseline({ t: legacy }, { t: legacy })).toEqual([]);
  });

  it("fails when a template switches from rule sections back to legacy", () => {
    const sections = { ...counts, ruleCountMethod: "rule_sections" as const };
    const legacy = {
      ...counts,
      imperativeRules: null,
      ruleCountMethod: "legacy_directives" as const,
    };
    expect(compareWithBaseline({ t: legacy }, { t: sections })).toEqual([
      "t: switched from rule sections back to legacy directives (rule 36)",
    ]);
    expect(() => lowerBaseline({ t: legacy }, { t: sections })).toThrow(/back to legacy/);
  });
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
        { t: { ...counts, imperativeRules: 13, ruleCountMethod: "rule_sections" } },
        { t: { ...counts, imperativeRules: null, ruleCountMethod: "legacy_directives" } },
      ),
    ).toEqual(["t: 13 imperative rules, over the cap of 12 (rule 11)"]);
    expect(
      compareWithBaseline(
        { "worker.system": { ...counts, imperativeRules: 13, ruleCountMethod: "rule_sections" } },
        { "worker.system": { ...counts, imperativeRules: 13, ruleCountMethod: "rule_sections" } },
      ),
    ).toEqual(["worker.system: 13 imperative rules, over the cap of 12 (rule 11)"]);
  });
});

describe("lowerBaseline (rule 36)", () => {
  const entry = (over: Record<string, unknown> = {}) => ({
    capitalWords: 0,
    imperativeRules: null,
    negations: 3,
    longToolDescriptions: 0,
    ruleCountMethod: "legacy_directives" as const,
    ...over,
  });

  it("lowers a count that fell and keeps the rest", () => {
    expect(lowerBaseline({ a: entry({ negations: 1 }) }, { a: entry() })).toEqual({
      a: entry({ negations: 1 }),
    });
  });

  it("refuses to raise a recorded count", () => {
    expect(() => lowerBaseline({ a: entry({ negations: 4 }) }, { a: entry() })).toThrow(
      "a: negations would rise from 3 to 4",
    );
  });

  it("refuses to drop a recorded template unless a rename is given", () => {
    expect(() => lowerBaseline({ b: entry() }, { a: entry() })).toThrow(
      /a: recorded but not rendered.*SEKHEMET_PROMPT_BASELINE_RENAME=a:b/,
    );
    expect(
      lowerBaseline({ b: entry({ negations: 2 }) }, { a: entry() }, { renames: { a: "b" } }),
    ).toEqual({
      b: entry({ negations: 2 }),
    });
    // A rename carries the old counts: they may not rise either.
    expect(() =>
      lowerBaseline({ b: entry({ negations: 4 }) }, { a: entry() }, { renames: { a: "b" } }),
    ).toThrow("b: negations would rise from 3 to 4");
  });

  it("refuses a new template that has capital emphasis or a long tool description", () => {
    expect(lowerBaseline({ n: entry({ negations: 9 }) }, {})).toEqual({
      n: entry({ negations: 9 }),
    });
    expect(() => lowerBaseline({ n: entry({ capitalWords: 1 }) }, {})).toThrow(
      "n: a new template may not record capitalWords 1 (rule 36)",
    );
    expect(() => lowerBaseline({ n: entry({ longToolDescriptions: 2 }) }, {})).toThrow(
      "n: a new template may not record longToolDescriptions 2 (rule 36)",
    );
  });

  it("lets a remeasure raise counts and record new violations, but not drop a template", () => {
    const opts = { remeasure: true };
    expect(lowerBaseline({ a: entry({ negations: 4 }) }, { a: entry() }, opts)).toEqual({
      a: entry({ negations: 4 }),
    });
    expect(
      lowerBaseline({ a: entry(), n: entry({ capitalWords: 2 }) }, { a: entry() }, opts),
    ).toEqual({ a: entry(), n: entry({ capitalWords: 2 }) });
    expect(() => lowerBaseline({ b: entry() }, { a: entry() }, opts)).toThrow(/recorded but not/);
    expect(() =>
      lowerBaseline(
        { a: entry() },
        { a: entry({ imperativeRules: 3, ruleCountMethod: "rule_sections" }) },
        opts,
      ),
    ).toThrow(/back to legacy/);
  });

  it("parses the rename switch", () => {
    expect(parseBaselineRenames(undefined)).toEqual({});
    expect(parseBaselineRenames("a:b, c.d:e.f")).toEqual({ a: "b", "c.d": "e.f" });
    expect(() => parseBaselineRenames("a")).toThrow(/old:new/);
  });
});

describe("the baseline file and the lint's measurement version (rule 36)", () => {
  const entry = (over: Record<string, unknown> = {}) => ({
    capitalWords: 1,
    imperativeRules: null,
    negations: 3,
    longToolDescriptions: 0,
    ruleCountMethod: "legacy_directives" as const,
    ...over,
  });
  const file = (over: Partial<PromptLintBaselineFile> = {}): PromptLintBaselineFile => ({
    about: "x",
    measureVersion: PROMPT_LINT_MEASURE_VERSION,
    remeasures: [{ version: 1, date: "2026-09-24", reason: "first" }],
    templates: { a: entry() },
    ...over,
  });
  const today = "2026-09-25";

  it("sums every count across templates", () => {
    expect(
      baselineTotals({ a: entry(), b: entry({ negations: 2, longToolDescriptions: 1 }) }),
    ).toEqual({ templates: 2, capitalWords: 2, negations: 5, longToolDescriptions: 1 });
  });

  it("carries the version and the remeasure log forward on a plain record", () => {
    const next = nextBaselineFile(file(), { a: entry({ negations: 1 }) }, { about: "y", today });
    expect(next).toEqual({
      about: "y",
      measureVersion: PROMPT_LINT_MEASURE_VERSION,
      remeasures: [{ version: 1, date: "2026-09-24", reason: "first" }],
      templates: { a: entry({ negations: 1 }) },
    });
  });

  it("refuses a plain record when the lint's measurement version changed", () => {
    expect(() =>
      nextBaselineFile(
        file({ measureVersion: PROMPT_LINT_MEASURE_VERSION - 1 }),
        { a: entry() },
        {
          about: "y",
          today,
        },
      ),
    ).toThrow(/SEKHEMET_PROMPT_BASELINE_REMEASURE/);
  });

  it("allows a remeasure only when the version changed, with a reason, and appends it", () => {
    const old = file({ measureVersion: PROMPT_LINT_MEASURE_VERSION - 1 });
    const next = nextBaselineFile(
      old,
      { a: entry({ negations: 9 }) },
      {
        about: "y",
        today,
        remeasure: "data tags are no longer checked",
      },
    );
    expect(next.measureVersion).toBe(PROMPT_LINT_MEASURE_VERSION);
    expect(next.remeasures).toEqual([
      { version: 1, date: "2026-09-24", reason: "first" },
      {
        version: PROMPT_LINT_MEASURE_VERSION,
        date: today,
        reason: "data tags are no longer checked",
      },
    ]);
    expect(next.templates.a?.negations).toBe(9);
    expect(() =>
      nextBaselineFile(
        file(),
        { a: entry({ negations: 9 }) },
        { about: "y", today, remeasure: "r" },
      ),
    ).toThrow(/measurement version is unchanged/);
    expect(() =>
      nextBaselineFile(old, { a: entry() }, { about: "y", today, remeasure: "  " }),
    ).toThrow(/reason/);
  });
});

describe("the B2.1 review's lint patterns (CX-M1-1)", () => {
  it("finds a do-not-read_file marker beside a read_file instruction for the same content", () => {
    expect(
      findContradictions(
        "=== SCOPE FILE: a.ts (current content; edit it, do not read_file it) ===\n(Context was cut to fit the window: part of a scope file (read_file with a line range).)",
      ),
    ).toEqual(['a "do not re-read" marker beside an instruction to read the file again']);
  });

  it("reads 'call only the tools named' as the closed-tool-set claim", () => {
    const text = "Tools: read_file, edit. Call only tools named in this prompt.";
    expect(findContradictions(text, { callableTools: ["read_file", "edit", "recall"] })).toEqual([
      '"No other tool exists" while recall is callable and not listed',
    ]);
  });
});

describe("the generic read remedy beside a do-not-read marker (confirmation review)", () => {
  it("is found", () => {
    expect(
      findContradictions(
        "=== SCOPE FILE: a.ts (current content; edit it, do not read_file it) ===\nHow to fix: Resolve TS9999 at a.ts:3. Read the surrounding lines before editing.",
      ),
    ).toEqual(['a "do not re-read" marker beside an instruction to read the file again']);
  });
});
