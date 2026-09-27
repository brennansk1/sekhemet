import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CardStore } from "../src/card_store.js";
import { EventLog } from "../src/log.js";
import { type DiskDb, openDiskDb } from "./support/disk_db.js";

// design-stage NEW-design-stage-6 (DS-TO-9, -11, -12, -14): the take-over's
// records — the brief as found with each claim's label bound to an executed
// result, one batch of questions, the evidenced backlog proposal and the
// person's approval, which applies the open defaults and seeds the
// requirement graph. Real SQLite files; the baseline and the inventory are
// appended as the take-over appends them.

const COMMIT = "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0";

describe("take-over records (DS-TO-9, -11, -12, -14)", () => {
  let disk: DiskDb;
  let log: EventLog;
  let store: CardStore;
  let baselineSeq: number;
  let projectId: string;

  /** The onboarding baseline: the suite ran twice; one test failed in both runs, one in one. */
  async function baseline(): Promise<number> {
    const e = await log.append({
      actor: "system",
      type: "project/baseline",
      payload: {
        kind: "recorded",
        entries: [
          {
            fingerprint: "f1",
            gate: "unit",
            rung: "test",
            file: "tests/cart.test.ts",
            rule: "totals a cart",
          },
        ],
        flaky: [
          {
            fingerprint: "f2",
            gate: "unit",
            rung: "test",
            file: "tests/login.test.ts",
            rule: "logs in",
            flaky: true,
          },
        ],
        runs: [
          { gate: "unit", rung: "test", run: 1, exitCode: 1, failing: ["f1", "f2"] },
          { gate: "unit", rung: "test", run: 2, exitCode: 1, failing: ["f1"] },
        ],
      },
    });
    return e.seq;
  }

  /** A baseline with nothing failing: the suite passed twice. */
  async function cleanBaseline(): Promise<number> {
    const e = await log.append({
      actor: "system",
      type: "project/baseline",
      payload: {
        kind: "recorded",
        entries: [],
        flaky: [],
        runs: [
          { gate: "unit", rung: "test", run: 1, exitCode: 0, failing: [] },
          { gate: "unit", rung: "test", run: 2, exitCode: 0, failing: [] },
        ],
      },
    });
    return e.seq;
  }

  async function inventory(findings: { id: string; kind: string; path?: string; line?: number }[]) {
    await log.append({
      actor: "system",
      type: "takeover/inventory",
      payload: { baselineSeq, findings },
      private: { recon: "README says it works" },
    });
  }

  beforeEach(async () => {
    disk = openDiskDb("sekhemet-takeover-");
    log = new EventLog(disk.db);
    store = new CardStore(disk.db, log);
    projectId = (await store.ensureProject({ rootPath: disk.dir, name: "Shop" })).id;
    baselineSeq = await baseline();
  });
  afterEach(() => disk.dispose());

  it("DS-TO-9: a proven claim cites a test that passed in both baseline runs; the link is proposed", async () => {
    await inventory([{ id: "F1", kind: "stub", path: "src/pay.ts", line: 3 }]);
    const t = store.takeover;
    // Proven with no executed result: refused.
    await expect(
      t.recordBriefAsFound({
        claims: [
          { id: "C1", label: "proven", citations: ["src/search.ts:10"], text: "Search works" },
        ],
      }),
    ).rejects.toThrow(/executed result/);
    // Proven by a test that failed in the baseline: refused.
    await expect(
      t.recordBriefAsFound({
        claims: [
          {
            id: "C1",
            label: "proven",
            citations: ["tests/cart.test.ts"],
            results: [{ kind: "test", ref: "tests/cart.test.ts > totals a cart", baselineSeq }],
            text: "Carts total",
          },
        ],
      }),
    ).rejects.toThrow(/failed/);
    // Proven by a flaky test: refused.
    await expect(
      t.recordBriefAsFound({
        claims: [
          {
            id: "C1",
            label: "proven",
            citations: ["tests/login.test.ts"],
            results: [{ kind: "test", ref: "tests/login.test.ts > logs in", baselineSeq }],
            text: "Login works",
          },
        ],
      }),
    ).rejects.toThrow(/failed/);
    // A result naming no baseline: refused.
    await expect(
      t.recordBriefAsFound({
        claims: [
          {
            id: "C1",
            label: "proven",
            citations: ["tests/search.test.ts"],
            results: [{ kind: "test", ref: "tests/search.test.ts > finds", baselineSeq: 9999 }],
            text: "Search works",
          },
        ],
      }),
    ).rejects.toThrow(/baseline/);
    // Every claim cites at least one file:line, test id or commit.
    await expect(
      t.recordBriefAsFound({
        claims: [{ id: "C2", label: "claimed_unproven", citations: [], text: "Has an admin page" }],
      }),
    ).rejects.toThrow(/cite/);

    await t.recordBriefAsFound({
      claims: [
        {
          id: "C1",
          label: "proven",
          citations: ["tests/search.test.ts"],
          results: [{ kind: "test", ref: "tests/search.test.ts > finds a product", baselineSeq }],
          text: "Search finds products",
        },
        {
          id: "C2",
          label: "claimed_unproven",
          citations: ["README.md:12"],
          text: "Has an admin page",
        },
        { id: "C3", label: "contradicted", citations: ["F1", COMMIT], text: "Payments work" },
      ],
    });
    const [event] = await log.getEventsByTypes(["takeover/brief_as_found"]);
    expect(JSON.stringify(event?.payload)).not.toContain("Search finds");
    expect(event?.private).toMatchObject({
      claimTexts: [
        { id: "C1", text: "Search finds products" },
        { id: "C2", text: "Has an admin page" },
        { id: "C3", text: "Payments work" },
      ],
    });
    const brief = await t.briefAsFound();
    expect(brief?.claims.map((c) => [c.id, c.label, c.linkState])).toEqual([
      ["C1", "proven", "proposed"],
      ["C2", "claimed_unproven", undefined],
      ["C3", "contradicted", undefined],
    ]);
  });

  it("DS-TO-11: one batch of at most five ranked questions, each default citing a finding; a small inventory gets one", async () => {
    baselineSeq = await cleanBaseline();
    await inventory([{ id: "F1", kind: "stub", path: "src/pay.ts", line: 3 }]);
    const ask = async (question: string) =>
      (
        await store.runs.requestDecision({
          kind: "takeover",
          question,
          context: "{}",
          options: ["Finish it", "Defer it"],
          recommendationIndex: 0,
        })
      ).id;
    const q1 = await ask("Should the payment stub be finished first?");
    const q2 = await ask("Keep the old search?");
    // The inventory holds one half-done finding and no contradicted claim: at most one question.
    await expect(
      store.takeover.postQuestions({
        questions: [
          { decisionId: q1, defaultCites: "F1" },
          { decisionId: q2, defaultCites: "F1" },
        ],
      }),
    ).rejects.toThrow(/at most one/);
    // A default cites a finding of the inventory.
    await expect(
      store.takeover.postQuestions({ questions: [{ decisionId: q1, defaultCites: "F9" }] }),
    ).rejects.toThrow(/F9/);
    const bad = await ask("Which requirements matter?");
    await expect(
      store.takeover.postQuestions({ questions: [{ decisionId: bad, defaultCites: "F1" }] }),
    ).rejects.toThrow(/requirements/);
    await store.takeover.postQuestions({ questions: [{ decisionId: q1, defaultCites: "F1" }] });
    const [posted] = await log.getEventsByTypes(["takeover/questions_posted"]);
    expect(posted?.payload).toMatchObject({
      questions: [{ decisionId: q1, rank: 1, defaultCites: "F1", policy: "safe_default" }],
    });
    // One batch.
    await expect(
      store.takeover.postQuestions({ questions: [{ decisionId: q2, defaultCites: "F1" }] }),
    ).rejects.toThrow(/one batch/);
  });

  it("DS-TO-11: no more than five questions on a larger inventory", async () => {
    await inventory(
      Array.from({ length: 6 }, (_, i) => ({
        id: `F${i + 1}`,
        kind: "todo",
        path: "src/a.ts",
        line: i + 1,
      })),
    );
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      ids.push(
        (
          await store.runs.requestDecision({
            kind: "takeover",
            question: `Question ${i}?`,
            context: "{}",
            options: ["Yes", "No"],
          })
        ).id,
      );
    }
    await expect(
      store.takeover.postQuestions({
        questions: ids.map((decisionId, i) => ({ decisionId, defaultCites: `F${i + 1}` })),
      }),
    ).rejects.toThrow(/five/);
  });

  it("DS-TO-12: every card is evidenced; a could-not-build finding gets a stabilise fix card; a secret is a person's task", async () => {
    await inventory([
      { id: "F1", kind: "could_not_build" },
      { id: "F2", kind: "stub", path: "src/pay.ts", line: 3 },
    ]);
    await log.append({
      actor: "system",
      type: "takeover/secrets_scanned",
      payload: {
        scanner: "builtin",
        commits: 4,
        findings: [{ commit: COMMIT, path: "config/.env", rule: "aws-access-key" }],
      },
    });
    const fix = {
      ref: "k1",
      bucket: "stabilise" as const,
      title: "Make the build pass",
      links: ["F1"],
      change: "fix" as const,
      assignee: "worker" as const,
      forFinding: "F1",
      redCheck: "build_fails_on_base" as const,
    };
    const rotate = {
      ref: "k2",
      bucket: "stabilise" as const,
      title: "Rotate the AWS key",
      links: [COMMIT],
      assignee: "person" as const,
      secret: { commit: COMMIT, path: "config/.env" },
    };
    const characterize = {
      ref: "k3",
      bucket: "finish" as const,
      title: "Pin down payments",
      links: ["F2"],
      change: "characterize" as const,
      assignee: "worker" as const,
      characterizes: ["k4"],
    };
    const finish = {
      ref: "k4",
      bucket: "finish" as const,
      title: "Finish payments",
      links: [
        "src/pay.ts:3",
        "tests/pay.test.ts > refunds a card twice",
        "https://github.com/acme/pay/issues/7",
      ],
      change: "feature" as const,
      assignee: "worker" as const,
      needsCharacterize: true,
    };
    const t = store.takeover;
    await expect(t.proposeBacklog({ cards: [rotate, characterize, finish] })).rejects.toThrow(/F1/);
    await expect(t.proposeBacklog({ cards: [fix, characterize, finish] })).rejects.toThrow(
      /secret/,
    );
    await expect(
      t.proposeBacklog({
        cards: [fix, { ...rotate, assignee: "worker" as const }, characterize, finish],
      }),
    ).rejects.toThrow(/person/);
    await expect(
      t.proposeBacklog({ cards: [fix, rotate, { ...characterize, links: [] }, finish] }),
    ).rejects.toThrow(/link/);
    await expect(t.proposeBacklog({ cards: [fix, rotate, finish, characterize] })).rejects.toThrow(
      /characterize/,
    );
    const proposalId = await t.proposeBacklog({ cards: [fix, rotate, characterize, finish] });
    expect(proposalId).toBe("TOP-1");
    const [event] = await log.getEventsByTypes(["takeover/backlog_proposed"]);
    expect(JSON.stringify(event?.payload)).not.toContain("Rotate");
    // A failing test's name and an issue's URL are the repository's text: private,
    // never in the hashed public payload.
    expect(JSON.stringify(event?.payload)).not.toContain("refunds a card twice");
    expect(JSON.stringify(event?.payload)).not.toContain("issues/7");
    expect((await t.backlog(proposalId))?.cards.find((c) => c.ref === "k4")?.links).toEqual(
      finish.links,
    );
    expect((await t.backlog(proposalId))?.cards.map((c) => [c.ref, c.title])).toEqual([
      ["k1", "Make the build pass"],
      ["k2", "Rotate the AWS key"],
      ["k3", "Pin down payments"],
      ["k4", "Finish payments"],
    ]);
  });

  it("DS-TO-14: nothing is created before approval; approval applies the open defaults and seeds the graph", async () => {
    await inventory([{ id: "F1", kind: "stub", path: "src/pay.ts", line: 3 }]);
    const t = store.takeover;
    await t.recordBriefAsFound({
      claims: [
        {
          id: "C1",
          label: "proven",
          citations: ["tests/search.test.ts"],
          results: [{ kind: "test", ref: "tests/search.test.ts > finds a product", baselineSeq }],
          text: "Search finds products",
        },
        {
          id: "C2",
          label: "claimed_unproven",
          citations: ["README.md:12"],
          text: "Has an admin page",
        },
        { id: "C3", label: "contradicted", citations: ["F1"], text: "Payments work" },
      ],
    });
    const q = await store.runs.requestDecision({
      kind: "takeover",
      question: "Should the payment stub be finished first?",
      context: "{}",
      options: ["Defer it", "Finish it"],
      recommendationIndex: 1,
    });
    await t.postQuestions({ questions: [{ decisionId: q.id, defaultCites: "F1" }] });
    const proposalId = await t.proposeBacklog({
      cards: [
        {
          ref: "k1",
          bucket: "finish",
          title: "Finish payments",
          links: ["F1"],
          change: "feature",
          assignee: "worker",
        },
      ],
    });
    expect(t.isPlanApproved(proposalId)).toBe(false);
    expect(await store.requirements.list()).toEqual([]);
    expect(store.runs.getDecision(q.id)?.status).toBe("pending");

    await expect(t.approvePlan({ proposalId, projectId }, "")).rejects.toThrow(/person/);
    const approved = await t.approvePlan({ proposalId, projectId }, "p_owner");
    expect(t.isPlanApproved(proposalId)).toBe(true);
    expect(approved.defaultsApplied).toEqual([q.id]);
    expect(store.runs.getDecision(q.id)).toMatchObject({
      status: "answered",
      selectedOptionIndex: 1,
    });
    const [applied] = await log.getEventsByTypes(["decision/default_applied"]);
    expect(applied?.payload).toEqual({ id: q.id, optionIndex: 1 });

    // The proven claim is a requirement with its baseline test proposed, unconfirmed.
    const [req] = await store.requirements.list({ projectId });
    expect(req).toMatchObject({
      source: "takeover",
      claimId: "C1",
      title: "Search finds products",
    });
    expect(approved.requirementIds).toEqual([req?.id]);
    expect(store.requirements.links(req?.id as string)).toEqual([
      {
        requirementId: req?.id,
        from: "test",
        ref: "tests/search.test.ts > finds a product",
        version: 1,
        suspect: false,
        proposed: true,
      },
    ]);
    await store.requirements.confirm(
      {
        requirementId: req?.id as string,
        from: "test",
        ref: "tests/search.test.ts > finds a product",
      },
      "p_owner",
    );
    expect(store.requirements.links(req?.id as string)[0]?.proposed).toBeUndefined();
    // The claimed-unproven claim is a candidate for the person; the contradicted one nothing.
    const candidates = await store.candidates.list({ projectId });
    expect(candidates.map((c) => [c.source, c.claimId, c.title])).toEqual([
      ["takeover", "C2", "Has an admin page"],
    ]);
    expect(approved.candidateIds).toEqual([candidates[0]?.id]);
    expect(approved.cards.map((c) => c.ref)).toEqual(["k1"]);
    const [event] = await log.getEventsByTypes(["takeover/plan_approved"]);
    expect(event?.principal).toBe("p_owner");
    await expect(t.approvePlan({ proposalId, projectId }, "p_owner")).rejects.toThrow(/already/);
  });

  /** A brief with one proven and one claimed-unproven claim, one batch question and a proposal. */
  async function readyToApprove(): Promise<{ proposalId: string; decisionId: string }> {
    await inventory([{ id: "F1", kind: "stub", path: "src/pay.ts", line: 3 }]);
    const t = store.takeover;
    await t.recordBriefAsFound({
      claims: [
        {
          id: "C1",
          label: "proven",
          citations: ["tests/search.test.ts"],
          results: [{ kind: "test", ref: "tests/search.test.ts > finds a product", baselineSeq }],
          text: "Search finds products",
        },
        {
          id: "C2",
          label: "claimed_unproven",
          citations: ["README.md:12"],
          text: "Has an admin page",
        },
      ],
    });
    const q = await store.runs.requestDecision({
      kind: "takeover",
      question: "Should the payment stub be finished first?",
      context: "{}",
      options: ["Defer it", "Finish it"],
      recommendationIndex: 1,
    });
    await t.postQuestions({ questions: [{ decisionId: q.id, defaultCites: "F1" }] });
    const proposalId = await t.proposeBacklog({
      cards: [
        {
          ref: "k1",
          bucket: "finish",
          title: "Finish payments",
          links: ["F1"],
          change: "feature",
          assignee: "worker",
        },
      ],
    });
    return { proposalId, decisionId: q.id };
  }

  it("DS-TO-14: a plan is approved only against the latest inventory", async () => {
    const { proposalId } = await readyToApprove();
    // A re-run records a new inventory and, finding no fresh cards, proposes no new backlog.
    await inventory([{ id: "F2", kind: "stub", path: "src/ship.ts", line: 9 }]);
    await expect(store.takeover.approvePlan({ proposalId, projectId }, "p_owner")).rejects.toThrow(
      /inventory/,
    );
    expect(store.takeover.isPlanApproved(proposalId)).toBe(false);
    expect(await store.requirements.list()).toEqual([]);
    expect(await log.getEventsByTypes(["decision/default_applied"])).toEqual([]);
  });

  it("DS-TO-14: the approval is on the ledger before any default or seed, and a failed seed resumes", async () => {
    const { proposalId, decisionId } = await readyToApprove();
    const t = store.takeover;
    const propose = vi
      .spyOn(store.candidates, "propose")
      .mockRejectedValueOnce(new Error("disk full"));
    await expect(t.approvePlan({ proposalId, projectId }, "p_owner")).rejects.toThrow(/disk full/);
    const order = (
      await log.getEventsByTypes([
        "takeover/plan_approved",
        "decision/default_applied",
        "requirement/created",
      ])
    ).map((e) => e.type);
    expect(order[0]).toBe("takeover/plan_approved");
    // Retried, it finishes what the approval began, once.
    propose.mockRestore();
    const resumed = await t.approvePlan({ proposalId, projectId }, "p_owner");
    expect(resumed.cards.map((c) => c.ref)).toEqual(["k1"]);
    expect(resumed.candidateIds).toHaveLength(1);
    expect((await store.requirements.list()).map((r) => r.claimId)).toEqual(["C1"]);
    expect(store.runs.getDecision(decisionId)?.status).toBe("answered");
    expect(await log.getEventsByTypes(["takeover/plan_approved"])).toHaveLength(1);
    await expect(t.approvePlan({ proposalId, projectId }, "p_owner")).rejects.toThrow(/already/);
  });

  it("DS-TO-9: a suite that exited non-zero naming no failure proves no test", async () => {
    const e = await log.append({
      actor: "system",
      type: "project/baseline",
      payload: {
        kind: "recorded",
        entries: [],
        flaky: [],
        runs: [
          { gate: "unit", rung: "test", run: 1, exitCode: 1, failing: [] },
          { gate: "unit", rung: "test", run: 2, exitCode: 0, failing: [] },
        ],
      },
    });
    baselineSeq = e.seq;
    await inventory([]);
    await expect(
      store.takeover.recordBriefAsFound({
        claims: [
          {
            id: "C1",
            label: "proven",
            citations: ["tests/search.test.ts"],
            results: [{ kind: "test", ref: "tests/search.test.ts > finds", baselineSeq }],
            text: "Search works",
          },
        ],
      }),
    ).rejects.toThrow(/exited/);
  });

  it("DS-TO-14: a take-over requirement names a proven claim of an approved plan", async () => {
    await expect(
      store.requirements.create(
        { title: "Search works", projectId, source: "takeover", claimId: "C1" },
        "p_owner",
      ),
    ).rejects.toThrow(/approved/);
    const { proposalId } = await readyToApprove();
    await expect(
      store.requirements.create(
        { title: "Search works", projectId, source: "takeover", claimId: "C1" },
        "p_owner",
      ),
    ).rejects.toThrow(/approved/);
    await store.takeover.approvePlan({ proposalId, projectId }, "p_owner");
    // The unproven claim is never a requirement of its own: only as a candidate a person accepts.
    await expect(
      store.requirements.create(
        { title: "Admin page", projectId, source: "takeover", claimId: "C2" },
        "p_owner",
      ),
    ).rejects.toThrow(/proven/);
  });
});
