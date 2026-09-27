import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyIssueReconciliation } from "../src/integrations.js";
import { runTakeover } from "../src/takeover.js";
import { approveTakeoverPlan } from "../src/takeover_backlog.js";
import { buildTakeoverFixture, fakeTracker } from "./takeover_fixtures.js";

/**
 * Inherited issues reconciled against the code (design-stage DS-TO-13;
 * integrations NEW-integrations-4, INT-42 to INT-44): each open issue of the
 * connected tracker proposed as done, duplicate, stale or valid with its
 * evidence — commits read with real git from the fixture's history — and
 * nothing on the tracker changed until a person applies the proposal.
 */
const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
beforeEach(() => {
  const trust = mkdtempSync(join(tmpdir(), "takeover-issues-trust-"));
  dirs.push(trust);
  vi.stubEnv("SEKHEMET_TRUST_DIR", trust);
});
afterEach(() => {
  vi.unstubAllEnvs();
  while (dbs.length) dbs.pop()?.close();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function ledger() {
  const dir = mkdtempSync(join(tmpdir(), "takeover-issues-db-"));
  dirs.push(dir);
  const db = new DatabaseSync(join(dir, "events.db"));
  dbs.push(db);
  initSchema(db);
  const log = new EventLog(db);
  return { db, log, cardStore: new CardStore(db, log) };
}

describe("DS-TO-13, INT-42 to INT-44: inherited issues", () => {
  it("proposes one verdict per open issue with its evidence, and writes nothing to the tracker", async () => {
    const fx = buildTakeoverFixture("inherited-issues");
    dirs.push(fx.root);
    const { cardStore, log } = ledger();
    // Issue #5 is already carried by a card: reconciled against it, no new card.
    const carried = await cardStore.createCard({
      tier: "story",
      title: "Show totals in euros",
      status: "backlog",
      externalRef: fx.issues[4]?.ref as NonNullable<(typeof fx.issues)[number]["ref"]>,
    });
    const tracker = fakeTracker(fx.issues);
    const report = await runTakeover(fx.root, {
      store: cardStore,
      log,
      principal: "p_owner",
      trusted: true,
      gitleaks: false,
      osvScanner: false,
      tracker,
      say: () => undefined,
    });
    expect(report.recon.issues).toBe("5 open issue(s) read from github");
    const rec = report.plan?.reconciliation;
    expect(rec?.id).toBe("REC-1");
    const by = new Map(rec?.issues.map((i) => [i.issue.id.split("#")[1], i]));
    // The closed issue is not reconciled.
    expect([...by.keys()].sort()).toEqual(["1", "2", "3", "4", "5"]);
    // #2: a commit closes it.
    expect(by.get("2")).toMatchObject({
      verdict: "done",
      evidence: [{ kind: "commit", ref: fx.commits[1] }],
    });
    // #3: the same title as #1.
    expect(by.get("3")).toMatchObject({
      verdict: "duplicate",
      evidence: [{ kind: "issue", ref: fx.issues[0]?.ref.id }],
    });
    // #4: every file it names was deleted, by this commit.
    expect(by.get("4")).toMatchObject({
      verdict: "stale",
      evidence: [{ kind: "commit", ref: fx.commits[2] }],
    });
    // #1: still open, a new card; the file it names exists.
    expect(by.get("1")).toMatchObject({ verdict: "valid", newCard: true });
    expect(by.get("1")?.evidence).toContainEqual({ kind: "file_line", ref: "src/total.ts:1" });
    // #5 says it is done, but nothing shows it (INT-44); a card already carries it.
    expect(by.get("5")).toMatchObject({ verdict: "valid", newCard: false, cardId: carried.id });
    // INT-43: nothing written before a person applies it.
    expect(tracker.writes).toEqual([]);
    expect(cardStore.reconciliation.isApplied("REC-1")).toBe(false);
    // The valid issue is a card of the backlog, linked to the issue.
    const cards =
      (await cardStore.takeover.backlog(report.plan?.proposalId as string))?.cards ?? [];
    const issueCard = cards.find((c) => c.links.includes(fx.issues[0]?.ref.id as string));
    expect(issueCard).toMatchObject({ bucket: "finish", assignee: "worker" });
    expect(cards.some((c) => c.links.includes(fx.issues[4]?.ref.id as string))).toBe(false);
  });

  it("applying writes through the one adapter and records the person; a second take-over proposes no card again", async () => {
    const fx = buildTakeoverFixture("inherited-issues");
    dirs.push(fx.root);
    const { cardStore, log } = ledger();
    const tracker = fakeTracker(fx.issues);
    const options = {
      store: cardStore,
      log,
      principal: "p_owner",
      trusted: true,
      gitleaks: false as const,
      osvScanner: false as const,
      tracker,
      say: () => undefined,
    };
    const first = await runTakeover(fx.root, options);
    const approved = await approveTakeoverPlan(
      { repoPath: fx.root, cardStore, log },
      { proposalId: first.plan?.proposalId as string },
      "p_owner",
    );
    const linked = approved.cards.find((c) => c.externalRef?.id === fx.issues[0]?.ref.id);
    expect(linked?.externalRef).toEqual(fx.issues[0]?.ref);
    const w = await applyIssueReconciliation(cardStore, tracker, "REC-1", "p_owner");
    expect(w.errors).toEqual([]);
    const proposal = await cardStore.reconciliation.get("REC-1");
    expect(proposal).toMatchObject({ state: "applied", principal: "p_owner" });
    const ids = (n: number) => fx.issues[n - 1]?.ref.id;
    // Done and duplicate are closed with a comment; stale is labelled and commented.
    expect(tracker.writes.filter((x) => x.kind === "update")).toEqual([
      { kind: "update", id: ids(2), body: { status: "done" } },
      { kind: "update", id: ids(3), body: { status: "done" } },
      { kind: "update", id: ids(4), body: { labels: ["stale"] } },
    ]);
    expect(tracker.writes.filter((x) => x.kind === "comment").map((x) => x.id)).toEqual([
      ids(2),
      ids(3),
      ids(4),
    ]);
    // Valid issues are left as they are.
    expect(tracker.writes.some((x) => x.id === ids(1) || x.id === ids(5))).toBe(false);
    // Applied once only.
    await expect(applyIssueReconciliation(cardStore, tracker, "REC-1", "p_owner")).rejects.toThrow(
      /already applied/,
    );
    const second = await runTakeover(fx.root, options);
    const again = second.plan?.reconciliation?.issues ?? [];
    expect(again.filter((i) => i.newCard)).toEqual([]);
  });

  it("with no tracker connected the issues are not read, and nothing is reconciled", async () => {
    const fx = buildTakeoverFixture("inherited-issues");
    dirs.push(fx.root);
    const { cardStore, log } = ledger();
    const report = await runTakeover(fx.root, {
      store: cardStore,
      log,
      principal: "p_owner",
      trusted: true,
      gitleaks: false,
      osvScanner: false,
      tracker: false,
      say: () => undefined,
    });
    expect(report.recon.issues).toBe("not read: no tracker connected");
    expect(await log.getEventsByTypes(["reconcile/proposed"])).toEqual([]);
  });

  it("a tracker write that fails leaves the reconciliation open to retry, and a retry writes nothing twice", async () => {
    const fx = buildTakeoverFixture("inherited-issues");
    dirs.push(fx.root);
    const { cardStore, log } = ledger();
    const tracker = fakeTracker(fx.issues);
    await runTakeover(fx.root, {
      store: cardStore,
      log,
      principal: "p_owner",
      trusted: true,
      gitleaks: false,
      osvScanner: false,
      tracker,
      say: () => undefined,
    });
    const ids = (n: number) => fx.issues[n - 1]?.ref.id;
    // The token expires on the stale issue's label.
    const update = tracker.update;
    tracker.update = async (ref, patch) => {
      if (ref.id === ids(4)) throw new Error("401 Bad credentials");
      return update(ref, patch);
    };
    const w = await applyIssueReconciliation(cardStore, tracker, "REC-1", "p_owner");
    expect(w.applied).toBe(false);
    expect(w.errors).toEqual([`${ids(4)}: 401 Bad credentials`]);
    expect(cardStore.reconciliation.isApplied("REC-1")).toBe(false);
    // Retried once the token is fixed: the closed issues are not written again.
    tracker.update = update;
    const closed = new Set([ids(2), ids(3)]);
    const pull = tracker.pull;
    tracker.pull = async (since) => (await pull(since)).filter((i) => !closed.has(i.ref.id));
    const before = tracker.writes.length;
    const again = await applyIssueReconciliation(cardStore, tracker, "REC-1", "p_owner");
    expect(again.applied).toBe(true);
    expect(cardStore.reconciliation.isApplied("REC-1")).toBe(true);
    expect(tracker.writes.slice(before).map((x) => x.id)).toEqual([ids(4), ids(4)]);
  });

  it("refuses to apply to a tracker other than the one the issues were read from, writing nothing", async () => {
    const fx = buildTakeoverFixture("inherited-issues");
    dirs.push(fx.root);
    const { cardStore, log } = ledger();
    const tracker = fakeTracker(fx.issues);
    await runTakeover(fx.root, {
      store: cardStore,
      log,
      principal: "p_owner",
      trusted: true,
      gitleaks: false,
      osvScanner: false,
      tracker,
      say: () => undefined,
    });
    const linear = { ...fakeTracker(fx.issues), system: "linear" as const };
    await expect(applyIssueReconciliation(cardStore, linear, "REC-1", "p_owner")).rejects.toThrow(
      /github.*linear|linear.*github/,
    );
    expect(linear.writes).toEqual([]);
    expect(cardStore.reconciliation.isApplied("REC-1")).toBe(false);
  });
});
