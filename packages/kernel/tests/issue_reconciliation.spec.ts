import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardStore } from "../src/card_store.js";
import { EventLog } from "../src/log.js";
import { type DiskDb, openDiskDb } from "./support/disk_db.js";

// integrations NEW-integrations-4 (INT-42, INT-43, INT-44; design-stage
// DS-TO-13): each inherited issue gets exactly one verdict with its evidence,
// as a proposal a person applies; a valid issue is a candidate card unless a
// card already carries it or an earlier proposal proposed it. Real SQLite.

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

describe("inherited-issue reconciliation (INT-42, INT-43, INT-44)", () => {
  let disk: DiskDb;
  let log: EventLog;
  let store: CardStore;
  beforeEach(async () => {
    disk = openDiskDb("sekhemet-reconcile-");
    log = new EventLog(disk.db);
    store = new CardStore(disk.db, log);
    await store.createCard({
      id: "c_synced",
      tier: "task",
      title: "Dark mode",
      externalRef: {
        system: "github",
        id: "acme/shop#7",
        url: "https://github.com/acme/shop/issues/7",
      },
    });
  });
  afterEach(() => disk.dispose());

  it("INT-42: one verdict per issue with evidence; valid issues are candidate cards unless a card carries them", async () => {
    const r = store.reconciliation;
    const proposal = await r.propose({
      issues: [
        {
          issue: { system: "github", id: "acme/shop#3" },
          verdict: "done",
          evidence: [{ kind: "test", ref: "tests/search.test.ts > finds", run: "baseline:12" }],
          why: "Search already ships",
        },
        {
          issue: { system: "github", id: "acme/shop#4" },
          verdict: "duplicate",
          evidence: [{ kind: "issue", ref: "acme/shop#3" }],
        },
        {
          issue: { system: "github", id: "acme/shop#5" },
          verdict: "stale",
          evidence: [{ kind: "commit", ref: COMMIT }],
        },
        {
          issue: { system: "github", id: "acme/shop#6" },
          verdict: "valid",
          evidence: [{ kind: "file_line", ref: "src/pay.ts:3" }],
        },
        {
          issue: { system: "github", id: "acme/shop#7" },
          verdict: "valid",
          evidence: [{ kind: "file_line", ref: "src/theme.ts:1" }],
        },
      ],
    });
    expect(proposal.id).toBe("REC-1");
    expect(proposal.issues.map((i) => [i.issue.id, i.newCard, i.cardId])).toEqual([
      ["acme/shop#3", false, undefined],
      ["acme/shop#4", false, undefined],
      ["acme/shop#5", false, undefined],
      ["acme/shop#6", true, undefined],
      ["acme/shop#7", false, "c_synced"],
    ]);
    const [event] = await log.getEventsByTypes(["reconcile/proposed"]);
    expect(JSON.stringify(event?.payload)).not.toContain("Search already ships");
    expect(event?.private).toMatchObject({ why: { "github:acme/shop#3": "Search already ships" } });

    // The same take-over run twice proposes no card a second time.
    const again = await r.propose({
      issues: [
        {
          issue: { system: "github", id: "acme/shop#6" },
          verdict: "valid",
          evidence: [{ kind: "file_line", ref: "src/pay.ts:3" }],
        },
      ],
    });
    expect(again.issues[0]?.newCard).toBe(false);
  });

  it("INT-42: an issue appears once, each with evidence, a duplicate names the other issue", async () => {
    const r = store.reconciliation;
    const issue = { system: "github" as const, id: "acme/shop#3" };
    await expect(
      r.propose({
        issues: [
          { issue, verdict: "stale", evidence: [{ kind: "commit", ref: COMMIT }] },
          { issue, verdict: "valid", evidence: [{ kind: "file_line", ref: "src/a.ts:1" }] },
        ],
      }),
    ).rejects.toThrow(/exactly one/);
    await expect(
      r.propose({ issues: [{ issue, verdict: "stale", evidence: [] }] }),
    ).rejects.toThrow(/evidence/);
    await expect(
      r.propose({
        issues: [{ issue, verdict: "duplicate", evidence: [{ kind: "commit", ref: COMMIT }] }],
      }),
    ).rejects.toThrow(/other issue/);
    await expect(
      r.propose({
        issues: [
          { issue, verdict: "wontfix" as never, evidence: [{ kind: "commit", ref: COMMIT }] },
        ],
      }),
    ).rejects.toThrow(/done, duplicate, stale or valid/);
    expect(await log.getEventsByTypes(["reconcile/proposed"])).toEqual([]);
  });

  it("INT-44: 'already done' needs an executed test run or a commit, never the issue's own word", async () => {
    const r = store.reconciliation;
    const issue = { system: "github" as const, id: "acme/shop#3" };
    await expect(
      r.propose({
        issues: [
          { issue, verdict: "done", evidence: [{ kind: "file_line", ref: "src/search.ts:4" }] },
        ],
      }),
    ).rejects.toThrow(/executed test or a commit/);
    await expect(
      r.propose({
        issues: [
          {
            issue,
            verdict: "done",
            evidence: [{ kind: "test", ref: "tests/search.test.ts > finds" }],
          },
        ],
      }),
    ).rejects.toThrow(/run/);
    const ok = await r.propose({
      issues: [{ issue, verdict: "done", evidence: [{ kind: "commit", ref: COMMIT }] }],
    });
    expect(ok.issues[0]?.verdict).toBe("done");
  });

  it("INT-43: nothing is applied until a person applies it, and who applied it is recorded", async () => {
    const r = store.reconciliation;
    const p = await r.propose({
      issues: [
        {
          issue: { system: "github", id: "acme/shop#5" },
          verdict: "stale",
          evidence: [{ kind: "commit", ref: COMMIT }],
        },
      ],
    });
    expect(r.isApplied(p.id)).toBe(false);
    expect((await r.open()).map((o) => o.id)).toEqual([p.id]);
    await expect(r.apply(p.id, "")).rejects.toThrow(/person/);
    const applied = await r.apply(p.id, "p_owner");
    expect(applied.issues).toHaveLength(1);
    expect(r.isApplied(p.id)).toBe(true);
    const [event] = await log.getEventsByTypes(["reconcile/applied"]);
    expect(event?.payload).toEqual({ id: p.id });
    expect(event?.principal).toBe("p_owner");
    await expect(r.apply(p.id, "p_owner")).rejects.toThrow(/already/);
    await expect(r.dismiss(p.id, "p_owner")).rejects.toThrow(/already/);
    expect(await r.open()).toEqual([]);

    const q = await r.propose({
      issues: [
        {
          issue: { system: "github", id: "acme/shop#8" },
          verdict: "valid",
          evidence: [{ kind: "file_line", ref: "src/a.ts:2" }],
        },
      ],
    });
    await r.dismiss(q.id, "p_owner");
    expect((await r.get(q.id))?.state).toBe("dismissed");
    // A dismissed proposal's card was never proposed: a later run proposes it.
    const later = await r.propose({
      issues: [
        {
          issue: { system: "github", id: "acme/shop#8" },
          verdict: "valid",
          evidence: [{ kind: "file_line", ref: "src/a.ts:2" }],
        },
      ],
    });
    expect(later.issues[0]?.newCard).toBe(true);
  });
});
