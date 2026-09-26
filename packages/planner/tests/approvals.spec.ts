import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { type InferenceResponse, MockInferenceAdapter } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import {
  CRITERIA_APPROVAL_HOLD,
  DecisionStore,
  type PlannerLedger,
  SpidrFeaturePlanner,
  StaleApprovalError,
  approvalView,
  approvePlan,
  codebaseMapFromRepo,
  crossCheckRows,
  needsPropertyTest,
  persistPlan,
  planApprovalView,
  resolveDepthProfile,
} from "../src/index.js";

/**
 * Test approval and strength by depth profile (planner-pm §2.17,
 * NEW-planner-pm-7, PM-N7-1…5): a person approves every card's criteria
 * before it leaves Planning; production approves the must-have example
 * tables and regulated every staged file; a changed file voids its
 * approval; production and regulated stage a seeded property test for an
 * invariant criterion and sample each must-have example row twice, posting a
 * decision when the two disagree.
 */
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function diskLedger(): PlannerLedger {
  const db = new DatabaseSync(join(tmp("sek-approve-db-"), "events.db"));
  initSchema(db);
  const log = new EventLog(db);
  return { log, store: new CardStore(db, log) };
}

function repo(devDependencies: Record<string, string> = { vitest: "^3.0.0" }): string {
  const root = tmp("sek-approve-repo-");
  const w = (rel: string, text: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  w("package.json", JSON.stringify({ name: "billing", devDependencies }));
  w("src/refund.ts", "export {};\n");
  return root;
}

const reply = (text: string): InferenceResponse => ({
  text,
  toolCalls: [],
  usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
});

const TABLE =
  "Given a paid invoice of 1000 cents, refunding 400 leaves 600; given a paid invoice of 500 cents, refunding 500 leaves 0";
const INVARIANT =
  "Refunding a paid invoice is idempotent: given a paid invoice of 1000 cents, refunding 400 twice leaves 600";

const slices = (criteria: { text: string; examples?: unknown[] }[]) =>
  JSON.stringify({
    slices: [
      {
        kind: "path",
        title: "Refund a paid invoice",
        keywords: ["refund", "invoice"],
        rationale: "The refund path first.",
        criteria,
        interface: [
          {
            symbol: "refundInvoice",
            file: "src/refund.ts",
            signature: "refundInvoice(paidCents: number, refundCents: number): number",
          },
        ],
      },
    ],
  });

async function planned(
  root: string,
  opts: {
    criteria?: { text: string; examples?: unknown[] }[];
    profile?: string;
    oracle?: MockInferenceAdapter;
  } = {},
) {
  const l = diskLedger();
  const spec = "Refund a paid invoice.";
  await l.store.createCard({ id: "epic_r", tier: "epic", title: spec, status: "in_progress" });
  const criteria = opts.criteria ?? [
    {
      text: TABLE,
      examples: [
        { args: [1000, 400], expected: 600 },
        { args: [500, 500], expected: 0 },
      ],
    },
  ];
  const adapter = new MockInferenceAdapter("planner", [reply(slices(criteria))], {
    exhaustion: "throw",
  });
  const plan = await new SpidrFeaturePlanner({
    adapter,
    codebaseMap: codebaseMapFromRepo(root),
  }).decomposeSpec({ parentId: "epic_r", parentTier: "epic", spec });
  const result = await persistPlan(l, plan, {
    epicId: "epic_r",
    repoRoot: root,
    depthProfile: resolveDepthProfile(opts.profile),
    ...(opts.oracle ? { oracle: opts.oracle } : {}),
  });
  const id = result.created[0]?.id as string;
  return { l, result, id };
}

describe("PM-N7-5: every card leaves Planning with a person's approval of its criteria", () => {
  it("persists every card in Planning until a person approves; the approval releases it", async () => {
    const root = repo();
    const { l, id, result } = await planned(root);
    const card = await l.store.getCard(id);
    expect(card?.status).toBe("planning");
    expect(card?.blockedReason).toContain(CRITERIA_APPROVAL_HOLD);
    expect(result.held.find((h) => h.id === id)?.reasons.join(" ")).toContain(
      CRITERIA_APPROVAL_HOLD,
    );
    // The board refuses the move without it, whatever the profile.
    const board = new BoardServiceImpl(l.store, { entryConditions: true });
    await expect(
      board.transitionCard({
        cardId: id,
        fromStatus: "planning",
        toStatus: "ready",
        actor: "planner",
      }),
    ).rejects.toThrow(/approval of its criteria/);

    // What a person is shown: the criteria and the example table, given → expected.
    const view = await approvalView(l, id, "internal tool");
    expect(view.criteria.map((c) => c.id)).toEqual([`${id}.c1`]);
    expect(view.examples.join("\n")).toContain("given [1000,400] → 600");
    expect(view.tests).toEqual([]);

    const principal = l.store.localPrincipal();
    const out = await approvePlan(l, "epic_r", principal);
    expect(out.approved).toEqual([id]);
    expect(out.released).toEqual([id]);
    const after = await l.store.getCard(id);
    expect(after?.status).toBe("ready");
    expect(after?.blockedReason ?? "").not.toContain(CRITERIA_APPROVAL_HOLD);
    expect(l.store.stagedTests.criteriaApproval(id)).toMatchObject({ approved: true, principal });
  });

  it("a card held for another reason keeps that hold after the approval", async () => {
    const root = repo();
    const { l, id } = await planned(root, {
      criteria: [{ text: TABLE }, { text: "Refunds are fast" }],
    });
    await approvePlan(l, "epic_r", l.store.localPrincipal());
    const card = await l.store.getCard(id);
    expect(card?.status).toBe("planning");
    expect(card?.blockedReason ?? "").not.toContain(CRITERIA_APPROVAL_HOLD);
    expect(card?.blockedReason).toMatch(/c2/);
  });

  it("refuses an approval without a person", async () => {
    const { l } = await planned(repo());
    await expect(approvePlan(l, "epic_r", "")).rejects.toThrow(/person/);
  });
});

describe("PM-N7-3/4: tests approved by the depth profile, void on change", () => {
  it("production approves the must-have example tables; the approval is bound to the content", async () => {
    const root = repo();
    const { l, id } = await planned(root, { profile: "production" });
    const view = await approvalView(l, id, "production");
    expect(view.tests.map((t) => t.what)).toEqual(["examples"]);
    const principal = l.store.localPrincipal();
    await approvePlan(l, "epic_r", principal, { profile: "production" });
    expect((await l.store.getCard(id))?.status).toBe("ready");
    const [approval] = l.store.stagedTests.testApprovals(id);
    expect(approval).toMatchObject({ approved: true, what: "examples", principal });

    // PM-N7-4: a new version of the staged file voids the approval.
    const path = approval?.path as string;
    const changed = `${readFileSync(join(root, path), "utf8")}\n// edited\n`;
    await l.store.stagedTests.stage({
      cardId: id,
      path,
      sha256: createHash("sha256").update(changed).digest("hex"),
      author: "planner",
      cases: l.store.stagedTests.staged(id)[0]?.cases ?? [],
    });
    const board = new BoardServiceImpl(l.store, {
      entryConditions: true,
      depthProfile: "production",
    });
    await board.transitionCard({
      cardId: id,
      fromStatus: "ready",
      toStatus: "backlog",
      actor: "planner",
    });
    await expect(
      board.transitionCard({
        cardId: id,
        fromStatus: "backlog",
        toStatus: "ready",
        actor: "planner",
      }),
    ).rejects.toThrow(/void/);
  });

  it("regulated approves every staged file; prototype and internal tool approve none", async () => {
    const { l, id } = await planned(repo(), { profile: "regulated" });
    expect((await approvalView(l, id, "regulated")).tests.map((t) => t.what)).toEqual(["file"]);
    expect((await approvalView(l, id, "prototype")).tests).toEqual([]);
    await approvePlan(l, "epic_r", l.store.localPrincipal(), { profile: "regulated" });
    expect(l.store.stagedTests.testApprovals(id)[0]).toMatchObject({
      approved: true,
      what: "file",
    });
    expect((await l.store.getCard(id))?.status).toBe("ready");
  });
});

describe("PM-N7-5 on the dashboard: an approval bound to what the person saw", () => {
  it("shows a plan's waiting cards with one SHA-256, and approves only at that SHA-256", async () => {
    const root = repo();
    const { l, id } = await planned(root, { profile: "production" });
    const shown = await planApprovalView(l, "epic_r", "production");
    expect(shown.profile).toBe("production");
    expect(shown.cards.map((c) => c.id)).toEqual([id]);
    expect(shown.cards[0]).toMatchObject({ status: "planning", approved: false });
    expect(shown.cards[0]?.criteria.map((c) => c.id)).toEqual([`${id}.c1`]);
    expect(shown.cards[0]?.tests[0]).toMatchObject({ what: "examples", approved: false });
    expect(shown.cards[0]?.tests[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(shown.sha256).toMatch(/^[0-9a-f]{64}$/);
    // The same content, the same hash; one card's own view hashes the same way.
    expect((await planApprovalView(l, "epic_r", "production")).sha256).toBe(shown.sha256);
    expect((await planApprovalView(l, id, "production")).cards.map((c) => c.id)).toEqual([id]);

    // The staged file changed after the person looked: their approval is refused.
    const [staged] = l.store.stagedTests.staged(id);
    const changed = `${readFileSync(join(root, staged?.path as string), "utf8")}\n// edited\n`;
    await l.store.stagedTests.stage({
      cardId: id,
      path: staged?.path as string,
      sha256: createHash("sha256").update(changed).digest("hex"),
      author: "planner",
      cases: staged?.cases ?? [],
    });
    const now = await planApprovalView(l, "epic_r", "production");
    expect(now.sha256).not.toBe(shown.sha256);
    const principal = l.store.localPrincipal();
    await expect(
      approvePlan(l, "epic_r", principal, { profile: "production", expectedSha256: shown.sha256 }),
    ).rejects.toBeInstanceOf(StaleApprovalError);
    expect(l.store.stagedTests.criteriaApproval(id).approved).toBe(false);
    expect((await l.store.getCard(id))?.status).toBe("planning");

    // At the hash of what is there now, it is approved and leaves Planning.
    const out = await approvePlan(l, "epic_r", principal, {
      profile: "production",
      expectedSha256: now.sha256,
    });
    expect(out.released).toEqual([id]);
    expect((await planApprovalView(l, "epic_r", "production")).cards[0]?.approved).toBe(true);
  });
});

describe("PM-N7-1: invariant criteria get a seeded property test at production or regulated", () => {
  it("recognises the invariant words", () => {
    for (const text of [
      "a refund never exceeds the invoice",
      "the total is always positive",
      "each payment is recorded exactly once",
      "applying the discount is idempotent",
      "for any amount the fee is rounded",
      "encoding then decoding a note is a round trip",
    ]) {
      expect(needsPropertyTest(text, "production")).toBe(true);
      expect(needsPropertyTest(text, "internal tool")).toBe(false);
    }
    expect(needsPropertyTest("refunding 400 of 1000 leaves 600", "production")).toBe(false);
  });

  it("stages a fast-check property with a fixed seed, recorded, and proposes the dependency", async () => {
    const root = repo();
    const invariant = [{ text: INVARIANT, examples: [{ args: [1000, 400], expected: 600 }] }];
    const { l, id, result } = await planned(root, { criteria: invariant, profile: "production" });
    const staged = l.store.stagedTests.staged(id);
    const property = staged.find((t) => /property/.test(t.path));
    expect(property?.cases?.[0]?.criterionId).toBe(`${id}.c1`);
    const source = readFileSync(join(root, property?.path as string), "utf8");
    expect(source).toContain('from "fast-check"');
    // A property that cannot fail against a stub must not cover the
    // criterion: the default (no round-trip, no numeric bound) property
    // requires a real, defined result before comparing two calls — an
    // empty export (undefined, or always throwing) now fails it.
    expect(source).toContain('"error" in first');
    expect(source).toContain("first.value === undefined");
    const recorded = await l.log.getEventsByTypes(["test/property_staged"]);
    const seed = (recorded[0]?.payload as { seed: number }).seed;
    expect(Number.isInteger(seed)).toBe(true);
    expect(source).toContain(`seed: ${seed}`);
    expect(recorded[0]?.payload).toMatchObject({ cardId: id, criterionId: `${id}.c1` });
    expect(result.proposedDependencies).toEqual([
      expect.objectContaining({ name: "fast-check", dev: true }),
    ]);
    // The same plan twice gives the same seed: it is fixed, not random.
    const again = await planned(repo(), { criteria: invariant, profile: "production" });
    const seed2 = (
      (await again.l.log.getEventsByTypes(["test/property_staged"]))[0]?.payload as { seed: number }
    ).seed;
    expect(seed2).toBe(seed);
  });

  it("stages no property test under the internal-tool default", async () => {
    const invariant = [{ text: INVARIANT, examples: [{ args: [1000, 400], expected: 600 }] }];
    const { l, id, result } = await planned(repo(), { criteria: invariant });
    expect(l.store.stagedTests.staged(id).some((t) => /property/.test(t.path))).toBe(false);
    expect(result.proposedDependencies).toEqual([]);
  });

  it("a numeric-bound property refuses to skip its assertion for a non-number result", async () => {
    const root = repo();
    const bound = [
      {
        text: "The refund total is never negative: given a paid invoice of 1000 cents, refunding 400 leaves 600",
        examples: [{ args: [1000, 400], expected: 600 }],
      },
    ];
    const { l, id } = await planned(root, { criteria: bound, profile: "production" });
    const property = l.store.stagedTests.staged(id).find((t) => /property/.test(t.path));
    const source = readFileSync(join(root, property?.path as string), "utf8");
    // The old code: `if ("value" in got && typeof got.value === "number") {
    // assert }`, so a non-number result (a stub returning undefined, or
    // one that throws) silently skipped the assertion, vacuously passing.
    expect(source).not.toMatch(/if \("value" in got && typeof got\.value === "number"\) \{/);
    expect(source).toContain("did not return a number");
    expect(source).toContain(">= 0");
  });
});

describe("PM-N7-2: must-have example rows are sampled twice at production", () => {
  it("posts a decision showing both values when the samples disagree, and stages neither until answered", async () => {
    const root = repo();
    // The independent second sample agrees on the first row, not the second.
    const oracle = new MockInferenceAdapter(
      "oracle",
      [reply('{"expected": 600}'), reply('{"expected": 5}')],
      { exhaustion: "throw" },
    );
    const { l, id } = await planned(root, { profile: "production", oracle });
    expect(oracle.callHistory).toHaveLength(2);
    // Independent: the second sample sees the spec and the call, never the
    // first sample's criterion or value.
    expect(oracle.callHistory[1]?.prompt).toContain("refundInvoice(500, 500)");
    expect(oracle.callHistory[1]?.prompt).not.toContain(TABLE);
    expect(oracle.callHistory[1]?.prompt).not.toContain("leaves 0");
    const [decision] = await new DecisionStore(l).waiting();
    expect(decision?.record.cardId).toBe(id);
    expect(decision?.request.options.map((o) => o.label)).toEqual(["0", "5"]);
    expect(decision?.request.question).toContain("[500,500]");
    expect(decision?.request.defaultIfNoAnswer.optionIndex).toBeUndefined();
    const card = await l.store.getCard(id);
    expect(card?.status).toBe("planning");
    expect(card?.blockedReason).toContain(`Waiting on decision ${decision?.id}`);
    const path = l.store.stagedTests.staged(id)[0]?.path as string;
    expect(readFileSync(join(root, path), "utf8")).not.toContain("expected: 5");
    expect(readFileSync(join(root, path), "utf8")).not.toContain("args: [500, 500]");

    // The person's answer is staged, and the card still waits for its approval.
    await new DecisionStore(l).answer(decision?.id as string, 0, "human", l.store.localPrincipal());
    const source = readFileSync(join(root, path), "utf8");
    expect(source).toContain("args: [500, 500], expected: 0");
    const staged = l.store.stagedTests.staged(id)[0];
    expect(staged?.sha256).toBe(createHash("sha256").update(source).digest("hex"));
    expect(staged?.cases).toHaveLength(2);
    const waiting = await l.store.getCard(id);
    expect(waiting?.status).toBe("planning");
    expect(waiting?.blockedReason).toContain(CRITERIA_APPROVAL_HOLD);
    await approvePlan(l, "epic_r", l.store.localPrincipal(), { profile: "production" });
    expect((await l.store.getCard(id))?.status).toBe("ready");
  });

  it("agreeing samples post nothing; the internal-tool default samples once", async () => {
    const agree = new MockInferenceAdapter(
      "oracle",
      [reply('{"expected": 600}'), reply('{"expected": 0}')],
      { exhaustion: "throw" },
    );
    const { l } = await planned(repo(), { profile: "production", oracle: agree });
    expect(await new DecisionStore(l).waiting()).toEqual([]);
    const unused = new MockInferenceAdapter("oracle", [], { exhaustion: "throw" });
    await planned(repo(), { oracle: unused });
    expect(unused.callHistory).toHaveLength(0);
  });

  it("a second sample the model cannot answer confirms nothing: the row is left out, not kept", async () => {
    // Malformed replies (no "expected" field): sampleExpected returns
    // undefined for each, per the model's own contract of not answering.
    const cannotAnswer = new MockInferenceAdapter(
      "oracle",
      [reply("not json at all"), reply('{"unrelated": true}')],
      { exhaustion: "throw" },
    );
    const rows = [
      { args: [1000, 400], expected: 600 },
      { args: [500, 500], expected: 0 },
    ];
    const checked = await crossCheckRows(cannotAnswer, {
      spec: "Refund a paid invoice.",
      symbol: { symbol: "refundInvoice", file: "src/refund.ts", signature: "" },
      rows,
    });
    expect(checked.kept).toEqual([]);
    expect(checked.disputed).toEqual([]);
  });
});
