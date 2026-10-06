import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { estimateTokens, lintPrompt } from "@sekhemet/context";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import {
  type InferenceRequest,
  type LocalInferenceAdapter,
  type ModelHold,
  ModelRegistry,
} from "@sekhemet/models";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reviewCard } from "../src/learning/review.js";
import {
  REVIEW_REPLY_SCHEMA,
  reviewCopy,
  reviewCopyFor,
  reviewMethod,
  withReviewMethod,
} from "../src/learning/review_copy.js";
import {
  applyEdits,
  changedRanges,
  fixtureCard,
  loadSeededDefects,
  reviewerAB,
} from "../src/learning/review_eval.js";
import { copyText, recordedLiteralInventory, rolePromptVersion } from "../src/prompt_versions.js";
import { runRoleEvalCommand } from "../src/role_eval_cmd.js";

// The Reviewer's prove method (R3b; review-git item 2.3.8, RG-P8-17;
// PROMPT_STANDARD rule 32): the switch, its place in the Review role's
// context version, rule 35's steps 1 and 2 (the lint and a golden render
// with its token count), and the paired seeded-set A/B that R3b and R3c run
// unattended. A scripted Review model; no model is loaded.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the switch (RG-P8-17)", () => {
  it("is baseline unless SEKHEMET_REVIEW_METHOD says prove, and refuses any other value", () => {
    expect(reviewMethod({})).toBe("baseline");
    expect(reviewMethod({ SEKHEMET_REVIEW_METHOD: "prove" })).toBe("prove");
    expect(() => reviewMethod({ SEKHEMET_REVIEW_METHOD: "proof" })).toThrow(
      /SEKHEMET_REVIEW_METHOD is baseline or prove, not proof/,
    );
  });

  it("gives the copy module the switch's method, so the Review role's context version names it", async () => {
    const inventory = recordedLiteralInventory();
    const baseline = await withReviewMethod("baseline", async () => ({
      text: copyText(reviewCopy),
      version: rolePromptVersion("reviewer", { inventory }),
      system: reviewCopy.system,
    }));
    const prove = await withReviewMethod("prove", async () => ({
      text: copyText(reviewCopy),
      version: rolePromptVersion("reviewer", { inventory }),
      system: reviewCopy.system,
    }));
    expect(baseline.system).toBe(reviewCopyFor("baseline").system);
    expect(prove.system).toBe(reviewCopyFor("prove").system);
    expect(prove.text).toMatch(/"method":"prove"/);
    expect(prove.version).not.toBe(baseline.version);
    // The Worker's own version does not move with the Reviewer's method (live-test F24).
    const worker = await withReviewMethod("prove", async () =>
      rolePromptVersion("worker", { inventory }),
    );
    expect(worker).toBe(rolePromptVersion("worker", { inventory }));
    vi.stubEnv("SEKHEMET_REVIEW_METHOD", "prove");
    expect(reviewCopy.method).toBe("prove");
  });
});

describe("rule 35, steps 1 and 2: the lint and the golden render", () => {
  const prove = reviewCopyFor("prove");

  it("lints clean: no emphasis, at most 12 rules, no more negations than the baseline's, no placeholder or contradiction", () => {
    const base = lintPrompt(reviewCopyFor("baseline").system);
    const report = lintPrompt(prove.system);
    expect(report.capitalWords).toEqual([]);
    expect(report.ruleCountMethod).toBe("rule_sections");
    expect(report.counts.imperativeRules).toBeLessThanOrEqual(12);
    expect(report.counts.negations).toBeLessThanOrEqual(base.counts.negations);
    expect(report.placeholders).toEqual([]);
    expect(report.contradictions).toEqual([]);
    expect(report.ruleViolations).toEqual([]);
  });

  it("renders the review request from a recorded input, with its token counts", async () => {
    const sent: InferenceRequest[] = [];
    const model: LocalInferenceAdapter = {
      modelId: "scripted-reviewer",
      supportedArms: ["arm_b_json"],
      contextWindow: { contextTokens: 32_768, maxTokens: 1200 },
      generate: async (req) => {
        sent.push(req);
        return {
          text: "{}",
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
        };
      },
    };
    await withReviewMethod("prove", () =>
      reviewCard(model, {
        card: {
          id: "c9",
          title: "Append ledger entries",
          spec: "Entries are appended in order.",
          acceptanceCriteria: ["append adds one entry", "entries keep their order"],
          criterionIds: ["AC-1", "AC-2"],
        },
        diff: [
          "diff --git a/src/ledger.ts b/src/ledger.ts",
          "--- a/src/ledger.ts",
          "+++ b/src/ledger.ts",
          "@@ -1,1 +1,2 @@",
          " const rows = [];",
          "+export function append(entry) { rows.push(entry); }",
          "",
        ].join("\n"),
        stagedTests: [
          { path: "tests/ledger.spec.ts", cases: [{ name: "appends", criterionId: "AC-1" }] },
        ],
        checks: [{ gate: "test", passed: true }],
        assumptions: ["Assumed: entries are strings"],
        preferences: ["Small functions"],
        rules: [],
      }),
    );
    expect(sent).toHaveLength(1);
    const req = sent[0] as InferenceRequest;
    expect(req.systemPrompt).toBe(prove.system);
    await expect(`${req.systemPrompt}\n\n----\n\n${req.prompt}\n`).toMatchFileSnapshot(
      "./__golden__/reviewer.prove.request.txt",
    );
    // Each section counted with the fallback estimator (CX-N1-2): no Review model tokenizer is calibrated yet.
    expect({
      system: estimateTokens(req.systemPrompt ?? ""),
      prompt: estimateTokens(req.prompt),
    }).toEqual({ system: 521, prompt: 314 });
    // The reply contract is the baseline's: the same JSON shape is read.
    expect(prove.system).toContain(
      '{"criteria":[{"n":1,"verdict":"met","at":"src/file.ts:12","note":""}]',
    );
  });
});

/** Two seeded defects in different issues, with where each one's change lies. */
function twoDefects() {
  const set = loadSeededDefects(ROOT);
  const picked = ["onyx-vault-get-audit-missing", "vanguard-hmac-timestamp-digits"].map((id) => {
    const d = set.items.find((x) => x.id === id);
    if (!d) throw new Error(`no seeded defect ${id}`);
    const ref = readFileSync(
      join(ROOT, "fixtures", "reference_solutions", d.fixture, d.card, d.file),
      "utf8",
    );
    const [lo] = changedRanges(ref, applyEdits(ref, d.edits))[0] ?? [1];
    return { id, title: fixtureCard(ROOT, d.fixture, d.card).title, file: d.file, line: lo };
  });
  return { set, picked };
}

/**
 * A Review model that cites the seeded line as unmet only under the prove
 * method (its system prompt), and otherwise judges every criterion met.
 */
function scriptedReviewer(picked: ReturnType<typeof twoDefects>["picked"]) {
  const requests: InferenceRequest[] = [];
  const adapter: LocalInferenceAdapter & { unload(): Promise<void> } = {
    modelId: "scripted-reviewer",
    supportedArms: ["arm_b_json"],
    contextWindow: { contextTokens: 32_768, maxTokens: 1200 },
    generate: async (req) => {
      requests.push(req);
      const d = picked.find((p) => req.prompt.includes(`Title: ${p.title}`));
      const proving = req.systemPrompt === reviewCopyFor("prove").system;
      const entry =
        proving && d
          ? { n: 1, verdict: "unmet", at: `${d.file}:${d.line}`, note: "A case is left out." }
          : { n: 1, verdict: "met", at: `${d?.file ?? "src/x.ts"}:1`, note: "" };
      return {
        text: JSON.stringify({ criteria: [entry], assumptions: [], preferences: [], outside: [] }),
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
      };
    },
    unload: async () => undefined,
  };
  return { adapter, requests };
}

describe("the Reviewer's reply is constrained to its schema (owner, 2026-10-05)", () => {
  it("names REVIEW_REPLY_SCHEMA on every review request, under both methods", async () => {
    const { set, picked } = twoDefects();
    const { adapter, requests } = scriptedReviewer(picked);
    await reviewerAB(set, {
      current: { method: "baseline", adapter },
      candidate: { method: "prove", adapter },
      only: picked.map((p) => p.id),
    });
    expect(requests.length).toBeGreaterThan(0);
    for (const r of requests) expect(r.responseSchema).toEqual(REVIEW_REPLY_SCHEMA);
    // The schema is the shape the reply text asks for, verdicts included.
    const props = REVIEW_REPLY_SCHEMA.properties;
    expect(Object.keys(props).sort()).toEqual([
      "assumptions",
      "criteria",
      "outside",
      "preferences",
    ]);
    expect(props.criteria.items.properties.verdict.enum).toEqual(["met", "unmet", "unclear"]);
  });
});

describe("the paired seeded-set A/B (R3b, R3c; RG-P8-17)", () => {
  it("reviews each item under both arms, pairs them, and adopts nothing", async () => {
    const { set, picked } = twoDefects();
    const { adapter } = scriptedReviewer(picked);
    const record = await reviewerAB(set, {
      current: { method: "baseline", adapter },
      candidate: { method: "prove", adapter },
      only: picked.map((p) => p.id),
    });
    expect(record.pairs).toEqual([
      { id: picked[0]?.id, current: false, candidate: true },
      { id: picked[1]?.id, current: false, candidate: true },
    ]);
    expect(record).toMatchObject({ gained: 2, lost: 0, partial: true });
    // Two discordant pairs cannot resolve at 0.05: no clear difference.
    expect(record.p).toBeCloseTo(0.5, 5);
    expect(record.verdict).toBe("no_clear_difference");
    expect(record.arms.candidate.contextVersion).not.toBe(record.arms.current.contextVersion);
  });

  it("`measure reviewer --method prove --reasoning medium --thinking-cap 8192` writes the paired record and its event", async () => {
    const repo = mkdtempSync(join(tmpdir(), "review-method-"));
    dirs.push(repo);
    const db = new DatabaseSync(join(repo, "events.db"));
    initSchema(db);
    const log = new EventLog(db);
    const { picked } = twoDefects();
    const { adapter, requests } = scriptedReviewer(picked);
    let released = 0;
    const acquire = async (role: "planner" | "reviewer"): Promise<ModelHold> => ({
      role,
      adapter,
      release: () => void released++,
    });
    const lines: string[] = [];
    const code = await runRoleEvalCommand(
      "reviewer",
      [
        "--model",
        "scripted-reviewer",
        "--method",
        "prove",
        "--reasoning",
        "medium",
        "--thinking-cap",
        "8192",
        "--only",
        picked.map((p) => p.id).join(","),
        "--out",
        "ab.json",
      ],
      {
        repoPath: repo,
        log,
        cardStore: new CardStore(db, log),
        harnessRoot: ROOT,
        acquire,
        registry: new ModelRegistry(join(repo, "models.json")),
        now: () => new Date("2026-10-04T12:00:00Z"),
      },
      (l) => lines.push(l),
    );
    expect(code).toBe(0);
    expect(released).toBe(1);
    // The current arm asks for no reasoning at the default cap; the candidate's for medium at 8,192.
    const current = requests.filter((r) => r.systemPrompt === reviewCopyFor("baseline").system);
    const candidate = requests.filter((r) => r.systemPrompt === reviewCopyFor("prove").system);
    expect(current).toHaveLength(2);
    expect(candidate).toHaveLength(2);
    expect(current.every((r) => r.reasoning === "off" && r.reasoningBudgetTokens === 2048)).toBe(
      true,
    );
    expect(
      candidate.every((r) => r.reasoning === "medium" && r.reasoningBudgetTokens === 8192),
    ).toBe(true);
    const file = join(repo, "ab.json");
    expect(existsSync(file)).toBe(true);
    const written = JSON.parse(readFileSync(file, "utf8")) as { kind: string; gained: number };
    expect(written).toMatchObject({ kind: "reviewer-paired-ab", gained: 2 });
    const [event] = await log.getEventsByTypes(["measure/settings_tuned"]);
    expect(event?.payload).toMatchObject({
      kind: "paired_ab",
      role: "reviewer",
      model: "scripted-reviewer",
      verdict: "no_clear_difference",
      partial: true,
      comparison: { better: 2, worse: 0 },
      candidates: [
        {
          id: "current",
          values: { reviewMethod: "baseline", reasoningLevel: "off", reasoningCapTokens: 2048 },
        },
        {
          id: "candidate",
          values: { reviewMethod: "prove", reasoningLevel: "medium", reasoningCapTokens: 8192 },
        },
      ],
    });
    expect((event?.payload as { adopted?: unknown }).adopted).toBeUndefined();
    expect(lines.join("\n")).toMatch(/caught 2 of 2 .*prove/);
    db.close();
  });
});
