import { describe, expect, it } from "vitest";
import {
  KEY_GROUPS,
  REVIEW_DESK_COPY,
  UI_LIB_MODULES,
  acceptBlockers,
  acceptPermissionText,
  builtByLabel,
  citationsOf,
  orderImplementationFiles,
  reviewCoverage,
  reviewerAbsence,
  reviewerFindings,
  supersessionRows,
  testApprovalRows,
} from "../src/index.js";

/**
 * dashboard NEW-dashboard-5 (§2.5.3–9): review for a team, and review that
 * forces a look. The Review surface's decisions as a pure model, with exact
 * outputs: file order by risk (DB-N5-1), the Reviewer's coverage (DB-N5-2),
 * what keeps Accept disabled (DB-N5-3, DB-N5-9), who built it (DB-N5-4), and
 * the Acceptance tests group's supersessions and approvals (DB-N5-7, -8).
 */

const entries = [
  { id: "f_met", verdict: "met", text: "criterion 1 met: src/a.ts:3 hashes the key" },
  { id: "f_unclear", verdict: "unclear", text: "criterion 3 unclear: src/b.ts:10-12" },
  { id: "f_unmet", verdict: "unmet", text: "criterion 2 unmet: no test exercises src/c.ts:5" },
  { id: "f_old", verdict: "consider", text: "- [consider] prefer const" },
];

describe("the Reviewer's findings (dashboard §2.5.3 4a)", () => {
  it("reads file:line citations, single lines and ranges", () => {
    expect(citationsOf("see src/a.ts:3 and packages/x/y.spec.ts:10-12, not v1.2")).toEqual([
      { file: "src/a.ts", from: 3, to: 3 },
      { file: "packages/x/y.spec.ts", from: 10, to: 12 },
    ]);
    expect(citationsOf("no location here")).toEqual([]);
  });

  it("orders unmet, unclear, then met; titles with the counts; open ids are the unacknowledged unmet and unclear", () => {
    const m = reviewerFindings(entries, new Set(["f_unclear"]));
    expect(m.title).toBe("AI review · 1 unmet, 1 unclear");
    expect(m.rows.map((r) => [r.id, r.verdict, r.acknowledged, r.needsAck])).toEqual([
      ["f_unmet", "unmet", false, true],
      ["f_unclear", "unclear", true, true],
      ["f_met", "met", false, false],
    ]);
    expect(m.open).toEqual(["f_unmet"]);
    expect(m.met).toBe(1);
    expect(m.rows[0]?.citations).toEqual([{ file: "src/c.ts", from: 5, to: 5 }]);
  });

  it("with only met findings the title counts them, and nothing is open", () => {
    const m = reviewerFindings([entries[0] as (typeof entries)[0]], new Set());
    expect(m.title).toBe("AI review · 1 met");
    expect(m.open).toEqual([]);
  });

  it("ignores entries without a met, unmet or unclear verdict (Seshat's preference notes)", () => {
    expect(reviewerFindings([entries[3] as (typeof entries)[0]], new Set()).rows).toEqual([]);
  });

  it("RG-P8-12: names the Review model that wrote the findings, and no confidence", () => {
    const m = reviewerFindings(
      entries.slice(0, 3).map((e) => ({ ...e, modelId: "gemma-4-26b" })),
      new Set(),
    );
    expect(m.title).toBe("AI review · gemma-4-26b · 1 unmet, 1 unclear");
    expect(JSON.stringify(m)).not.toMatch(/confiden/i);
  });

  it("RG-P8-10: with no findings, says why no AI review ran; findings replace the note", () => {
    const note = { id: "n1", verdict: "not_reviewed", text: REVIEW_DESK_COPY.noReviewer };
    expect(reviewerAbsence([note])).toBe(
      "No AI review: no Review model outside the Coding model's family is configured.",
    );
    expect(reviewerFindings([note], new Set()).rows).toEqual([]);
    expect(reviewerAbsence([note, entries[0] as (typeof entries)[0]])).toBeUndefined();
    expect(reviewerAbsence([])).toBeUndefined();
    expect(REVIEW_DESK_COPY.reviewFailed("the model timed out")).toBe(
      "AI review could not run (the model timed out). The checks passed; the change reaches you unreviewed.",
    );
  });
});

describe("DB-N5-1: Implementation files ordered by risk, never alphabetically", () => {
  const files = [
    { path: "src/a.ts", added: 40, removed: 2 },
    { path: "src/b.ts", added: 1, removed: 0 },
    { path: "src/c.ts", added: 3, removed: 0 },
    { path: "src/d.ts", added: 9, removed: 9 },
    { path: "src/e.ts", added: 2, removed: 0 },
  ];
  it("failures first (more failures first), then unmet or unclear citations, then changed lines", () => {
    const order = orderImplementationFiles(files, {
      failures: [
        { location: { file: "src/e.ts", line: 1 } },
        { location: { file: "src/b.ts", line: 1 } },
        { location: { file: "src/b.ts", line: 2 } },
      ],
      findings: entries,
    });
    // b (2 failures), e (1), then c (unmet), then a (42 lines), d (18).
    // src/b.ts is also cited by an unclear finding but failures rank first.
    expect(order).toEqual(["src/b.ts", "src/e.ts", "src/c.ts", "src/a.ts", "src/d.ts"]);
  });

  it("a met finding does not raise a file; ties keep the diff's order", () => {
    const order = orderImplementationFiles(
      [
        { path: "z.ts", added: 1, removed: 0 },
        { path: "a.ts", added: 1, removed: 0 },
        { path: "src/a.ts", added: 1, removed: 0 },
      ],
      { failures: [], findings: [entries[0] as (typeof entries)[0]] },
    );
    expect(order).toEqual(["z.ts", "a.ts", "src/a.ts"]);
  });
});

describe("DB-N5-2: the Reviewer's coverage", () => {
  const changed = [
    { path: "src/a.ts", addedLines: [1, 2, 3, 4] },
    { path: "src/b.ts", addedLines: [10, 11, 12, 20] },
    { path: "src/c.ts", addedLines: [5] },
  ];
  it("counts files read and changed lines cited by no finding, and lists both", () => {
    const cov = reviewCoverage(changed, entries, ["src/a.ts", "src/b.ts"]);
    expect(cov.line).toBe(
      "AI review read 2 of 3 files; 4 of 9 changed lines are cited by no finding.",
    );
    expect(cov.notRead).toEqual(["src/c.ts"]);
    expect(cov.uncited).toEqual(["src/a.ts:1–2", "src/a.ts:4", "src/b.ts:20"]);
  });

  it("says so when the Reviewer recorded no files read", () => {
    const cov = reviewCoverage(changed, entries, undefined);
    expect(cov.line).toBe(
      "AI review did not record which files it read; 4 of 9 changed lines are cited by no finding.",
    );
    expect(cov.notRead).toEqual([]);
  });
});

describe("DB-N5-3: Accept stays disabled until every finding is acknowledged and every file shown", () => {
  it("writes which remain", () => {
    const b = acceptBlockers({
      openFindings: ["f1", "f2"],
      implementationFiles: ["src/a.ts", "src/b.ts", "src/c.ts"],
      shown: new Set(["src/a.ts"]),
    });
    expect(b.files).toEqual(["src/b.ts", "src/c.ts"]);
    expect(b.text).toBe("2 findings to acknowledge · 2 files not yet shown: src/b.ts, src/c.ts");
  });

  it("names three files at most", () => {
    const b = acceptBlockers({
      openFindings: [],
      implementationFiles: ["a", "b", "c", "d", "e"],
      shown: new Set(),
    });
    expect(b.text).toBe("5 files not yet shown: a, b, c and 2 more");
  });

  it("is empty when nothing remains", () => {
    expect(
      acceptBlockers({ openFindings: ["f1"], implementationFiles: ["a"], shown: new Set(["a"]) })
        .text,
    ).toBe("1 finding to acknowledge");
    expect(
      acceptBlockers({ openFindings: [], implementationFiles: ["a"], shown: new Set(["a"]) }),
    ).toEqual({ findings: 0, files: [], text: "" });
  });
});

describe("DB-N5-9: independent accept names who may accept", () => {
  const who = [{ principal: "p_bob", name: "Bob" }, { principal: "p_carol" }];
  it("the builder and the delegator are told who may", () => {
    expect(
      acceptPermissionText({ may: false, code: "not_independent", because: "built", who }),
    ).toBe(
      "You built this issue; on a team another Accept-holder accepts it. Who may accept: Bob, p_carol.",
    );
    expect(
      acceptPermissionText({ may: false, code: "not_independent", because: "delegated", who: [] }),
    ).toBe(
      "You delegated this issue to the agent; on a team another Accept-holder accepts it. Who may accept: no other Accept-holder yet.",
    );
  });
  it("a person without Accept is told who holds it; one who may accept is told nothing", () => {
    expect(acceptPermissionText({ may: false, code: "not_permitted", who })).toBe(
      "You do not hold the Accept permission on this project. Who may accept: Bob, p_carol.",
    );
    expect(acceptPermissionText({ may: true })).toBe("");
  });
  it("a person who owns none of the files, where a code owner must accept, is told who owns them", () => {
    expect(acceptPermissionText({ may: false, code: "not_code_owner", who })).toBe(
      "This project needs a code owner's accept, and you own none of this issue's files. Who may accept: Bob, p_carol.",
    );
    expect(acceptPermissionText({ may: false, code: "not_code_owner", who: [] })).toBe(
      "This project needs a code owner's accept, and you own none of this issue's files. Who may accept: no code owner is named in CODEOWNERS for these files.",
    );
  });
});

describe("DB-N5-4: a person-built card says so", () => {
  it("in the outcome line and in Facts", () => {
    expect(builtByLabel({ kind: "person", id: "p_jane", name: "Jane" })).toEqual({
      outcome: "Built by Jane (person)",
      fact: "Jane (person)",
    });
    expect(builtByLabel({ kind: "person", id: "p_jane" }).outcome).toBe("Built by p_jane (person)");
    expect(builtByLabel(undefined)).toEqual({ outcome: "", fact: "Agent" });
  });
});

describe("DB-N5-7, DB-N5-8: the Acceptance tests group", () => {
  it("lists each superseded base test beside its new version", () => {
    expect(
      supersessionRows(
        ["tests/sum.spec.ts > adds two", "tests/sum.spec.ts > rounds"],
        [{ test: "tests/sum.spec.ts > adds two", staged: ["acceptance/sum_v2.spec.ts"] }],
      ),
    ).toEqual([
      { old: "tests/sum.spec.ts > adds two", new: "acceptance/sum_v2.spec.ts" },
      { old: "tests/sum.spec.ts > rounds", new: REVIEW_DESK_COPY.supersededNotNeeded },
    ]);
    expect(supersessionRows(undefined, undefined)).toEqual([]);
  });

  it("shows each test's approval state; a voided approval reads Needs approval again", () => {
    expect(
      testApprovalRows([
        {
          path: "acceptance/a.spec.ts",
          approved: true,
          approvedSha256: "aa",
          by: "Jane",
          what: "examples",
        },
        {
          path: "acceptance/b.spec.ts",
          approved: true,
          approvedSha256: "bb",
          by: "Jane",
          what: "file",
        },
        { path: "acceptance/c.spec.ts", approved: false },
        { path: "acceptance/d.spec.ts", approved: false, approvedSha256: "dd", by: "Sam" },
      ]),
    ).toEqual([
      {
        path: "acceptance/a.spec.ts",
        state: "approved",
        label: "Approved by Jane · example table",
      },
      { path: "acceptance/b.spec.ts", state: "approved", label: "Approved by Jane" },
      { path: "acceptance/c.spec.ts", state: "needs", label: "Needs approval" },
      { path: "acceptance/d.spec.ts", state: "again", label: "Needs approval again" },
    ]);
  });
});

it("DB-N5-3: `x` acknowledges the focused finding, in the Review keys", () => {
  const review = KEY_GROUPS.find((g) => g.name === "Review");
  expect(review?.rows.find((r) => r.label === "Acknowledge the focused finding")?.keys).toEqual([
    "x",
  ]);
});

it("is served to the browser as /app/lib/review_desk.js", () => {
  expect(UI_LIB_MODULES).toContain("review_desk.js");
});
