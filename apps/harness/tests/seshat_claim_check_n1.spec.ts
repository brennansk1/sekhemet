import type {
  InferenceRequest,
  InferenceResponse,
  LocalInferenceAdapter,
  ToolCall,
} from "@sekhemet/models";
import { describe, expect, it } from "vitest";
import { type PmSnapshot, answer, claimsProposal } from "../src/pm/agent.js";
import { SESHAT_CLAIM_CHECK } from "../src/pm/pm_copy.js";
import type { PmMessage } from "../src/pm/types.js";

/**
 * N1-CLAIM (overnight run N1, 2026-10-09): Seshat (nail-mtp) replied "I've
 * proposed starting a project…" and later "I've proposed two changes…", yet
 * the turn made no proposal (no `start_project` or `propose_*` call; the
 * replies carried none). The model never certifies its own work: a reply
 * that claims a proposal its turn did not make is shown with a plain notice
 * that it proposed nothing new. The model is asked once (no re-ask: an
 * unmeasured prompt variant, PROMPT_STANDARD rule 35), and the notice never
 * denies a proposal still open from an earlier turn. Nothing loads: the
 * model is a fake.
 */

/** The four claims the run's replies made, verbatim openings (ledger seq 14, 21, 101, 21's last line). */
const REAL_CLAIMS = [
  "I've proposed starting a project for the Larkfield Tool Library Lending Desk.\n\n**Brief:** A lending desk.",
  "Needs a decision from Ruth: keep the old fee for loans already out? Default after Friday: keep the old fee, as your rule says.\n\nI've proposed two changes:\n1. `tools` gain `category` (hand/power).",
  "The board is empty, so I cannot list Done, In flight, or Needs you items. I've proposed two issues to implement the rules: 1. `tools.category`.",
  "Why: the first change is an enabler for the second.\n\nProposed changes, 2. Your call.",
];

const MORE_CLAIMS = [
  "I have created a new issue for the CSV export.",
  "I just drafted a split of card_7 into two stories.",
  "I've added an issue for the overdue list.",
  "I have also proposed a new sprint for next week.",
  "I proposed the change above.",
  "Here are the two proposed changes for your review.",
];

const INNOCENT = [
  "Here is the answer.",
  "I could propose splitting card_7 if you want.",
  "Would you like me to propose a new project for this?",
  "Nothing has been proposed yet.",
  "I have not proposed anything: the brief leaves the fee rule open.",
  "I haven't proposed a change, because the rule is still open.",
  "I've proposed no changes this time; the board already covers it.",
  "You proposed a change last week, and Ruth applied it.",
  "The Agent created the issue's branch and the checks passed.",
  "If I proposed a split now, the sprint would slip.",
  "Should I propose a change to the fee rule?",
  "I have not proposed changes yet: the fee rule is still open.",
  "I have no proposed changes for this.",
  "Needs a decision from Ruth: keep the old fee for loans already out?",
  // Back-references to earlier turns, and an object outside the claim's clause (review of N1).
  "As I proposed earlier, the split of card_7 is waiting for your review.",
  "I proposed two changes yesterday; they are waiting for your decision in Needs you.",
  "I have created the project you applied yesterday; its board holds 6 issues.",
  "I started the sprint on Monday, and two issues are done.",
  "When you applied it, I created three issues.",
  "I added the fee rule to the brief's open questions, not to any issue.",
  "I have already created the issues for that release.",
];

describe("N1-CLAIM: the claim detector is conservative", () => {
  it("catches each claim the run's replies made", () => {
    for (const t of REAL_CLAIMS) expect(claimsProposal(t), t).toBe(true);
  });

  it("catches other first-person claims to have proposed or created work", () => {
    for (const t of MORE_CLAIMS) expect(claimsProposal(t), t).toBe(true);
  });

  it("leaves offers, questions, negations, other actors and conditionals alone", () => {
    for (const t of INNOCENT) expect(claimsProposal(t), t).toBe(false);
  });
});

const snapshot: PmSnapshot = {
  project: "larkfield",
  cards: [],
  cycles: [],
  recentRuns: [],
  worker: { model: "nail-mtp", record: "no attempts yet" },
  pmModel: "nail-mtp",
  today: "2026-10-09",
};

const message: PmMessage = {
  id: "m1",
  seq: 1,
  role: "user",
  text: "Build me a lending desk for the tool library.",
  createdAt: "2026-10-09T07:34:55Z",
  state: "done",
};

const reply = (text: string, toolCalls: ToolCall[] = []): InferenceResponse => ({
  text,
  toolCalls,
  usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
});

const startProject: ToolCall = {
  id: "1",
  name: "start_project",
  arguments: { brief: "a lending desk for the tool library", reason: "you asked for it" },
};

function scripted(replies: InferenceResponse[]) {
  const seen: InferenceRequest[] = [];
  const model: LocalInferenceAdapter = {
    modelId: "nail-mtp",
    supportedArms: ["arm_a_flat"],
    contextWindow: { contextTokens: 16_384, maxTokens: 2048 },
    generate: async (req) => {
      seen.push(req);
      const next = replies[Math.min(seen.length - 1, replies.length - 1)];
      if (!next) throw new Error("no scripted reply");
      return next;
    },
  };
  return { model, seen };
}

const openEarlier: PmMessage = {
  id: "m0",
  seq: 0,
  role: "assistant",
  text: "I propose splitting card_7.",
  createdAt: "2026-10-08T07:00:00Z",
  state: "done",
  proposals: [{ id: "p1", kind: "split_card", summary: "Split card_7", state: "open" }],
};

describe("N1-CLAIM: a claimed proposal the turn did not make is never left standing", () => {
  it("asks the model once and adds the notice that the reply proposed nothing new", async () => {
    const { model, seen } = scripted([
      reply("I've proposed starting a project for the Larkfield Tool Library."),
    ]);
    const result = await answer(model, snapshot, [], [message]);
    expect(seen).toHaveLength(1);
    expect(result.proposals).toEqual([]);
    expect(result.text).toBe(
      `I've proposed starting a project for the Larkfield Tool Library.\n\n${SESHAT_CLAIM_CHECK.notice}`,
    );
  });

  it("the notice never denies that a proposal exists, only that this reply made one", () => {
    expect(SESHAT_CLAIM_CHECK.notice).toMatch(/this reply/i);
    expect(SESHAT_CLAIM_CHECK.notice).not.toMatch(
      /no proposal was made|there is nothing to review/i,
    );
    expect(Object.keys(SESHAT_CLAIM_CHECK)).toEqual(["notice"]);
  });

  it("adds no notice while a proposal from an earlier turn is still open", async () => {
    const { model, seen } = scripted([reply("I've proposed two changes: see Needs you.")]);
    const result = await answer(model, snapshot, [openEarlier], [message]);
    expect(seen).toHaveLength(1);
    expect(result.text).toBe("I've proposed two changes: see Needs you.");
  });

  it("adds the notice when the earlier proposals are all applied or discarded", async () => {
    const settled: PmMessage = {
      ...openEarlier,
      proposals: [{ id: "p1", kind: "split_card", summary: "Split card_7", state: "applied" }],
    };
    const { model } = scripted([reply("I've proposed two issues to implement the rules.")]);
    const result = await answer(model, snapshot, [settled], [message]);
    expect(result.text).toBe(
      `I've proposed two issues to implement the rules.\n\n${SESHAT_CLAIM_CHECK.notice}`,
    );
  });

  it("adds nothing when the claim is backed by a proposal, or when nothing is claimed", async () => {
    const backed = scripted([reply("I've proposed starting the project below.", [startProject])]);
    const a = await answer(backed.model, snapshot, [], [message]);
    expect(backed.seen).toHaveLength(1);
    expect(a.proposals).toHaveLength(1);
    expect(a.text).not.toContain(SESHAT_CLAIM_CHECK.notice);

    const plain = scripted([reply("Is the fee rule per loan or per member?")]);
    const b = await answer(plain.model, snapshot, [], [message]);
    expect(plain.seen).toHaveLength(1);
    expect(b.text).toBe("Is the fee rule per loan or per member?");
  });
});
