import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerAsset } from "@sekhemet/eval";
import type { LocalInferenceAdapter, ToolCall } from "@sekhemet/models";
import { describe, expect, it } from "vitest";
import {
  type PmConversation,
  type SeshatEvalResult,
  compareSkillRuns,
  evalSnapshot,
  inventedIds,
  loadPmConversations,
  runSeshatEval,
  scoreReply,
} from "../src/pm/eval.js";
import { SESHAT_SKILL_VERSION } from "../src/pm/seshat_skill.js";

// PM-P6-13, PM-N9-4: the scripted-conversation evaluation's scorer, proved
// offline with a scripted PM model — the exemplar replies meet every rubric
// item; a scripted bad run fails exactly the items it breaks. No model loads.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DRAFTS = join(ROOT, "fixtures", "pm_conversations", "drafts");
const drafts = JSON.parse(readFileSync(join(DRAFTS, "items.json"), "utf8")) as (PmConversation & {
  status?: string;
  labelledBy?: unknown;
})[];

/** The drafts registered in a scratch repository, labelled by a stand-in person. */
function registered(): string {
  const root = mkdtempSync(join(tmpdir(), "pm-conv-"));
  const dir = join(root, "fixtures", "pm_conversations");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "items.json"),
    JSON.stringify(
      drafts.map(({ status: _s, ...c }) => ({
        ...c,
        labelledBy: { principal: "person: test-owner", kind: "person" },
      })),
    ),
  );
  copyFileSync(join(DRAFTS, "boards.json"), join(dir, "boards.json"));
  writeFileSync(
    join(root, "fixtures", "eval_assets.json"),
    JSON.stringify({ about: "", assets: [] }),
  );
  registerAsset(
    root,
    {
      name: "pm-conversations",
      path: "fixtures/pm_conversations",
      labelledBy: "person: test-owner",
    },
    { modelIds: [] },
  );
  return root;
}

/** A PM model that replays the scripted replies in order, recording nothing else. */
function scripted(
  replies: { text: string; calls?: ToolCall[] }[],
  modelId = "pm-model",
): LocalInferenceAdapter {
  let i = 0;
  return {
    modelId,
    supportedArms: ["arm_a_flat"],
    contextWindow: { contextTokens: 32_768, maxTokens: 1200 },
    generate: async () => {
      const r = replies[i++] ?? { text: "" };
      return {
        text: r.text,
        toolCalls: r.calls ?? [],
        usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
      };
    },
  };
}

const exemplars = (set: PmConversation[], runs = 1) =>
  Array.from({ length: runs }, () => set.flatMap((c) => c.exemplar ?? [])).flat();

/** The bad run: each change breaks named items of one conversation. */
const BROKEN: Record<
  string,
  { reply: (c: PmConversation) => { text: string; calls?: ToolCall[] }; fails: string[] }
> = {
  standup: {
    reply: (c) => ({ text: `Great question! ${c.exemplar?.[0]?.text}` }),
    fails: ["answer_first", "voice"],
  },
  "why-failed": {
    reply: (c) => ({
      text: `${c.exemplar?.[0]?.text} It also blocks \`CHR-99\`.`,
      calls: c.exemplar?.[0]?.calls ?? [],
    }),
    fails: ["no_invented_ids"],
  },
  split: { reply: (c) => ({ text: c.exemplar?.[0]?.text ?? "" }), fails: ["split_not_retry"] },
  "plan-sprint": {
    reply: () => ({
      text: "For Sprint 13 I suggest 24 points, the 22 points you have averaged over the last three sprints plus 2. Based on: the board.",
    }),
    // "Based on: the board" names no source the board holds (the tightened rubric).
    fails: ["sprint_bet", "cites_source"],
  },
  "at-risk": {
    reply: () => ({
      text: "One thing: Hasher (`CHR-3`) has been in progress since 27 September, longer than the 85th-percentile cycle time of finished issues. Based on: the board.",
    }),
    fails: ["not_at_risk"],
  },
  "start-calculator": {
    reply: (c) => ({
      text: `${c.exemplar?.[0]?.text} Should it also handle percentages?`,
      calls: c.exemplar?.[0]?.calls ?? [],
    }),
    fails: ["zero_questions"],
  },
  "start-billing": {
    reply: () => ({ text: "I've proposed starting it now with one release of monthly charges." }),
    fails: ["brief"],
  },
  "new-issue": {
    reply: (c) => ({
      text: c.exemplar?.[0]?.text ?? "",
      calls: [
        {
          name: "propose_create_card",
          arguments: {
            title: "Export the ledger as CSV",
            spec: "Export the ledger as CSV.",
            acceptance_criteria: ["It works."],
            reason: "a person asked for it",
          },
        },
      ],
    }),
    fails: ["proposals_invest"],
  },
  "drop-from-sprint": {
    reply: (c) => ({
      text: c.exemplar?.[0]?.text ?? "",
      calls: [{ name: "propose_move_card", arguments: { card_id: "CHR-8", to: "backlog" } }],
    }),
    fails: ["proposals_reasoned"],
  },
  forecast: {
    reply: () => ({ text: "It will take 3 weeks. Hasher (`CHR-3`) is the long pole." }),
    fails: ["answer_first", "numbers_with_basis"],
  },
};

describe("the drafted conversations (measurement rule 29, MS-T11-4)", () => {
  it("are 20, each a draft awaiting a person, with exemplar replies and a board", () => {
    expect(drafts).toHaveLength(20);
    const boards = JSON.parse(readFileSync(join(DRAFTS, "boards.json"), "utf8")) as Record<
      string,
      unknown
    >;
    for (const c of drafts) {
      expect(c.status).toBe("draft — awaiting a person's confirmation");
      expect(c.labelledBy).toBeUndefined();
      expect(c.exemplar?.length).toBe(c.turns.length);
      expect(typeof c.board === "string" ? boards[c.board] : c.board).toBeDefined();
    }
    // PM-P6-13 names two of them: the calculator and the billing service.
    expect(drafts.find((c) => c.id === "start-calculator")?.expect.zeroQuestions).toBe(true);
    expect(drafts.find((c) => c.id === "start-billing")?.expect.brief).toBe(true);
  });

  it("are not registered, so nothing is scored against them yet (MS-T11-7)", () => {
    expect(() => loadPmConversations(ROOT)).toThrow(/pm-conversations is not registered.*B4\.8/);
  });
});

describe("the scorer, proved with a scripted PM model (PM-P6-13)", () => {
  it("scores the exemplar replies 20 of 20 on every run, recording the skill version and model", async () => {
    const set = loadPmConversations(registered());
    const result = await runSeshatEval(set, scripted(exemplars(set.conversations, 2)), { runs: 2 });
    const missed = result.runs.flatMap((r) =>
      r.conversations
        .filter((c) => !c.met)
        .map(
          (c) =>
            `${c.id}: ${c.items
              .filter((i) => !i.ok)
              .map((i) => `${i.item} (${i.detail})`)
              .join("; ")}`,
        ),
    );
    expect(missed).toEqual([]);
    expect(result.runs.map((r) => [r.met, r.total])).toEqual([
      [20, 20],
      [20, 20],
    ]);
    expect(result.passes).toBe(true);
    expect(result.skillVersion).toBe(SESHAT_SKILL_VERSION);
    expect(result.model).toBe("pm-model");
    expect(result.assetHash).toBe(set.hash);
    // Every item the criterion names is scored somewhere in the set.
    const scored = new Set(
      result.runs[0]?.conversations.flatMap((c) => c.items.map((i) => i.item)),
    );
    for (const item of [
      "answer_first",
      "numbers_with_basis",
      "no_invented_ids",
      "cites_source",
      "voice",
      "proposals_reasoned",
      "proposals_invest",
      "zero_questions",
      "brief",
      "not_at_risk",
      "sprint_bet",
      "split_not_retry",
      "failure_facts",
      "says_missing",
    ])
      expect(scored.has(item as never)).toBe(true);
  });

  it("fails a scripted bad run on exactly the items each reply breaks", async () => {
    const set = loadPmConversations(registered());
    const replies = set.conversations.flatMap((c) => {
      const broken = BROKEN[c.id];
      return broken ? [broken.reply(c)] : (c.exemplar ?? []);
    });
    const result = await runSeshatEval(set, scripted(replies), { runs: 1 });
    const run = result.runs[0];
    const failed = Object.fromEntries(
      (run?.conversations ?? [])
        .filter((c) => !c.met)
        .map((c) => [c.id, [...new Set(c.items.filter((i) => !i.ok).map((i) => i.item))].sort()]),
    );
    expect(failed).toEqual(
      Object.fromEntries(Object.entries(BROKEN).map(([id, b]) => [id, [...b.fails].sort()])),
    );
    expect(run?.met).toBe(10);
    expect(result.passes).toBe(false);
  });

  it("never gives a partial run the verdict", async () => {
    const set = loadPmConversations(registered());
    const only = set.conversations.filter((c) => c.id === "goal");
    const result = await runSeshatEval(set, scripted(exemplars(only)), { runs: 1, only: ["goal"] });
    expect(result.runs[0]?.met).toBe(1);
    expect(result.partial).toBe(true);
    expect(result.passes).toBe(false);
  });
});

describe("two skill versions compared paired (measurement rules 10-11)", () => {
  const run = (
    skill: string,
    met: boolean[],
    model = "pm-model",
    hash = "h1",
  ): SeshatEvalResult => ({
    kind: "seshat-conversations",
    assetHash: hash,
    assetVersion: "1",
    skillVersion: skill,
    model,
    at: "2026-09-28T00:00:00.000Z",
    runs: [
      {
        run: 1,
        met: met.filter(Boolean).length,
        total: met.length,
        conversations: met.map((m, i) => ({ id: `c${i}`, met: m, items: [], replies: [] })),
      },
    ],
    passes: false,
    line: "",
  });

  it("resolves a large paired difference by the exact McNemar test and states the resolution", () => {
    const a = run(
      "skill/2",
      Array.from({ length: 20 }, () => true),
    );
    const b = run(
      "skill/1",
      Array.from({ length: 20 }, (_, i) => i >= 10),
    );
    const c = compareSkillRuns(a, b);
    expect([c.pairs, c.aOnly, c.bOnly]).toEqual([20, 10, 0]);
    expect(c.p).toBeCloseTo(2 * 0.5 ** 10, 6);
    expect(c.verdict).toBe("a_better");
    expect(c.line).toMatch(/detectable on 20 paired/);
  });

  it("calls a small difference no clear difference", () => {
    const a = run(
      "skill/2",
      Array.from({ length: 20 }, (_, i) => i !== 0),
    );
    const b = run(
      "skill/1",
      Array.from({ length: 20 }, (_, i) => i !== 1 && i !== 2),
    );
    expect(compareSkillRuns(a, b).verdict).toBe("no_clear_difference");
  });

  it("refuses runs on different sets or different models", () => {
    const a = run("skill/2", [true]);
    expect(() => compareSkillRuns(a, run("skill/1", [true], "pm-model", "h2"))).toThrow(
      /different conversation sets/,
    );
    expect(() => compareSkillRuns(a, run("skill/1", [true], "other-model"))).toThrow(
      /holds the model fixed/,
    );
  });
});

describe("rubric items in isolation", () => {
  const board = JSON.parse(readFileSync(join(DRAFTS, "boards.json"), "utf8")).chronicle;
  const snapshot = evalSnapshot(board, "pm-model");

  it("flags an id the board does not hold, never a word that only looks like one", () => {
    expect(
      inventedIds("Hasher (`CHR-3`) uses SHA-256; see CHR-40 and `ev_d3ad`.", snapshot),
    ).toEqual(expect.arrayContaining(["CHR-40", "ev_d3ad"]));
    expect(
      inventedIds(
        "Hasher (`CHR-3`) uses SHA-256 (`A-1`, `ev_7f3a`); see `find_library`, e-mail.",
        snapshot,
      ),
    ).toEqual([]);
  });

  it("wants a basis beside each number", () => {
    const score = (text: string) =>
      scoreReply({ expect: {} }, snapshot, { text, cites: [{ cardId: "CHR-3" }], calls: [] }).find(
        (i) => i.item === "numbers_with_basis",
      )?.ok;
    expect(score("13 of 21 points are done with 4 days left.")).toBe(true);
    expect(score("It needs 5 days.")).toBe(false);
    // The basis is named with the number: a count, a percentile or a source.
    expect(score("Hasher lands in 3 days.")).toBe(false);
    expect(score("It needs 12 more hours of the Agent's time.")).toBe(false);
    expect(score("The fix takes 2-3 days.")).toBe(false);
    expect(score("About 3 days left.")).toBe(false);
    expect(score("Done in 3 days, the 85th percentile of the last 9 issues.")).toBe(true);
    expect(score("5–8 days, from the median of 12 finished issues.")).toBe(true);
    expect(score("3 of 7 issues are done.")).toBe(true);
    expect(score("The bet is 17 points, 85% of the mean over the last 3 sprints.")).toBe(true);
  });

  it("wants a real source: a cited id, or Based on naming one", () => {
    const cited = (text: string, cites: { cardId?: string; evidenceId?: string }[] = []) =>
      scoreReply({ expect: {} }, snapshot, { text, cites, calls: [] }).find(
        (i) => i.item === "cites_source",
      )?.ok;
    // The reviewer's reproduction: a number whose "basis" is the number itself, and no source.
    const weak =
      "Hasher lands in 3 days. It needs 12 more hours of the Agent's time. Based on the board.";
    expect(cited(weak)).toBe(false);
    expect(
      scoreReply({ expect: {} }, snapshot, { text: weak, cites: [], calls: [] }).find(
        (i) => i.item === "numbers_with_basis",
      )?.ok,
    ).toBe(false);
    expect(cited("Hasher is on track.", [{ cardId: "CHR-3" }])).toBe(true);
    expect(cited("Hasher is on track.\n\nBased on: CHR-3.")).toBe(true);
    expect(cited("Hasher is on track.\n\nBased on: evidence ev_7f3a.")).toBe(true);
    // An id the board does not hold is no source.
    expect(cited("Hasher is on track.\n\nBased on: ev_1a2b3c.")).toBe(false);
    expect(cited("Hasher is on track.\n\nBased on: CHR-99.")).toBe(false);
  });

  it("limits the failure evidence to the issues the message names, as the product does", () => {
    expect(
      evalSnapshot(board, "m", { asked: "why did the ledger issue fail?" }).failures,
    ).toHaveLength(1);
    expect(evalSnapshot(board, "m", { asked: "why did retention fail?" }).failures).toBeUndefined();
  });
});
