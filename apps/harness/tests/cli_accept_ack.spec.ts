import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CardStore } from "@sekhemet/kernel";
import { describe, expect, it } from "vitest";
import { openLocalLedger } from "../src/ledger_cmds.js";
import { recordLedgerRun } from "../src/ledger_evidence.js";
import { cardInReview, sandboxDirs, sekhemet } from "./cli_fixture.js";

/**
 * FINDINGS_C1 CLI-01 (severity 4) and CLI-08, through the built binary: the
 * AI review's findings are numbered in `sekhemet review`, Accept names the
 * ones still open by number and takes `--ack`, with Accept's own checks
 * (review-git §2.4.3, RG-N5-5); Review shows exactly the change being
 * accepted, against where its branch started, and a skipped check is not a
 * failed one.
 */

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

/** The AI review's entries on the issue's dossier, after its latest evidence. */
async function findings(
  repo: string,
  cardId: string,
  entries: [verdict: string, text: string][],
): Promise<string[]> {
  const { db, log } = openLocalLedger(repo);
  try {
    const store = new CardStore(db, log);
    const ids: string[] = [];
    for (const [verdict, text] of entries) {
      const e = await store.recordDossierEntry({
        cardId,
        kind: "review",
        actor: "reviewer",
        verdict,
        text,
      } as Parameters<CardStore["recordDossierEntry"]>[0]);
      ids.push(e.entryId);
    }
    return ids;
  } finally {
    db.close();
  }
}

async function issue(repo: string, id: string) {
  const { db, log } = openLocalLedger(repo);
  try {
    const store = new CardStore(db, log);
    return {
      status: (await store.getCard(id))?.status,
      decided: (await store.cardEvents(id, ["review/decided"])).map((e) => e.payload),
    };
  } finally {
    db.close();
  }
}

describe("CLI-01: accepting an issue with AI review findings from the command line", () => {
  it("review numbers the findings; accept names the open ones by number, exits 2, and accepts once each is acknowledged with --ack", async () => {
    const where = sandboxDirs();
    await cardInReview(where, "c1");
    const ids = await findings(where.cwd, "c1", [
      ["unmet", "criterion 2 is not exercised"],
      ["unclear", "the error path is untested"],
      ["met", "criterion 1 holds"],
    ]);

    const review = sekhemet(["review", "c1"], where);
    expect(review.status, review.stderr).toBe(0);
    expect(review.stdout).toMatch(/AI review/);
    expect(review.stdout).toMatch(/1\. Unmet: criterion 2 is not exercised/);
    expect(review.stdout).toMatch(/2\. Unclear: the error path is untested/);
    expect(review.stdout).toMatch(/3\. Met: criterion 1 holds/);
    expect(review.stdout).toContain("sekhemet accept c1 --ack 1,2");
    expect(review.stdout).not.toMatch(UUID);

    const refused = sekhemet(["accept", "c1"], where);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toMatch(/findings 1 and 2\b/);
    expect(refused.stderr).toContain("sekhemet accept c1 --ack 1,2");
    expect(refused.stderr).not.toMatch(UUID);
    expect((await issue(where.cwd, "c1")).status).toBe("review");

    const partial = sekhemet(["accept", "c1", "--ack", "1"], where);
    expect(partial.status).toBe(2);
    expect(partial.stderr).toMatch(/finding 2\b/);
    expect(partial.stderr).not.toMatch(/findings 1 and 2/);

    const unknown = sekhemet(["accept", "c1", "--ack", "1,2,7"], where);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toMatch(/no finding 7/);
    expect((await issue(where.cwd, "c1")).status).toBe("review");

    const accepted = sekhemet(["accept", "c1", "--ack", "1,2"], where);
    expect(accepted.stderr).toBe("");
    expect(accepted.status).toBe(0);
    expect(accepted.stdout).toMatch(/Accepted c1/);
    const after = await issue(where.cwd, "c1");
    expect(after.status).toBe("done");
    // RG-S6-6: the decision records the findings acknowledged, by entry.
    expect(after.decided.at(-1)).toMatchObject({
      decision: "accept",
      acknowledgedFindings: [ids[0], ids[1]],
    });
  });

  it("an issue whose files were not looked at is refused with exit 1, naming `sekhemet review`", async () => {
    const where = sandboxDirs();
    await cardInReview(where, "c2");
    // A new attempt's evidence: the files shown before it no longer count.
    const { db, log } = openLocalLedger(where.cwd);
    const store = new CardStore(db, log);
    const path = join(".sekhemet", "evidence", "ev_c2.json");
    await recordLedgerRun(store, {
      cardId: "c2",
      modelId: "scripted",
      passed: true,
      stopReason: "gate_passed",
      evidenceId: "ev_c2",
      path,
      body: readFileSync(join(where.cwd, path), "utf8"),
      filesTouched: ["src/b.ts"],
    });
    db.close();
    const r = sekhemet(["accept", "c2"], where);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/look at src\/b\.ts/);
    expect(r.stderr).toContain("sekhemet review c2");
  });
});

describe("CLI-08: Review shows exactly the change being accepted", () => {
  it("diffs against where the issue's branch started, so later work on main is not shown as deleted", async () => {
    const where = sandboxDirs();
    await cardInReview(where, "c3");
    // Someone else's work lands on main after the issue's branch was cut.
    mkdirSync(join(where.cwd, "docs"), { recursive: true });
    writeFileSync(join(where.cwd, "docs", "brief.md"), "# The brief\n");
    execFileSync("git", ["add", "docs/brief.md"], { cwd: where.cwd });
    execFileSync("git", ["commit", "-q", "-m", "brief"], { cwd: where.cwd });

    const r = sekhemet(["review", "c3"], where);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("src/b.ts");
    expect(r.stdout).toContain("+export const b = 2;");
    expect(r.stdout).not.toContain("brief.md");
    expect(r.stdout).not.toContain("The brief");
  });

  it("names a skipped check as skipped, never as failed", async () => {
    const where = sandboxDirs();
    await cardInReview(where, "c4", {
      rungResults: [
        {
          gate: "unit",
          rung: "test",
          layer: "functional",
          passed: true,
          exitCode: 0,
          durationMs: 5,
        },
        {
          gate: "e2e",
          rung: "test",
          layer: "functional",
          passed: false,
          skipped: true,
          exitCode: 0,
          durationMs: 0,
          reason: "no browser",
        },
      ],
    });
    const r = sekhemet(["review", "c4"], where);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/✓ unit/);
    expect(r.stdout).toMatch(/e2e skipped/);
    expect(r.stdout).not.toMatch(/✗ e2e/);
  });
});
