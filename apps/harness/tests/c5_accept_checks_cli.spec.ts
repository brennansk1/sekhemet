import { describe, expect, it } from "vitest";
import { cardBranchHead, latestLedgerEvidence } from "../src/ledger_evidence.js";
import { cliAsync, g6Repo, inReview, statusOf, write } from "./support/g6_review.js";

/**
 * Accept and someone else's CI (integrations INT-37, kernel K-N8-4; C2d
 * finding routed to C5): `sekhemet accept` spawned as the built binary
 * (`apps/harness/dist/index.js`, through `support/g6_review.ts`) over a real
 * repository, card branch and ledger. The external result is on the ledger
 * as the queue's pull-request advance records it (`recordExternalChecks`).
 */

async function withExternalResult(
  r: ReturnType<typeof g6Repo>,
  id: string,
  check: { name: string; passed: boolean; headSha?: string },
): Promise<void> {
  await r.ledger(async ({ store }) => {
    const evidence = await latestLedgerEvidence(store, id);
    if (!evidence) throw new Error(`no evidence for ${id}`);
    const headSha = check.headSha ?? (cardBranchHead(r.repo, id) as string);
    await store.runs.recordGateResult({
      attemptId: evidence.attemptId,
      cardId: id,
      gate: check.name,
      layer: "functional",
      passed: check.passed,
      exitCode: check.passed ? 0 : 1,
      durationMs: 1,
      failures: [],
      source: "external",
      externalRef: {
        system: "github",
        checkName: check.name,
        runUrl: "https://github.com/o/r/runs/11",
        headSha,
      },
    });
  });
}

describe("INT-37 at Accept: a declared blocking external check that failed at the branch head", () => {
  it("INT-37: `accept` refuses while a check named in [review] blocking_checks failed at the card branch's head, naming it; undeclared, the same failure is advisory and the card is accepted", async () => {
    const r = g6Repo("sek-int37-");
    await inReview(r, "c1", { files: { "src/b.ts": "export const b = 2;\n" } });
    await withExternalResult(r, "c1", { name: "ci/build", passed: false });
    write(r.repo, ".sekhemet/config.toml", '[review]\nblocking_checks = ["ci/build"]\n');
    const refused = await cliAsync(r, ["accept", "c1"]);
    const told = refused.stdout + refused.stderr;
    expect(refused.status, told).not.toBe(0);
    expect(told).toMatch(/ci\/build/);
    expect(await statusOf(r, "c1")).toBe("review");

    // Advisory when the project does not declare it (INT-37's second clause).
    write(r.repo, ".sekhemet/config.toml", "[review]\nblocking_checks = []\n");
    const accepted = await cliAsync(r, ["accept", "c1"]);
    expect(accepted.status, accepted.stdout + accepted.stderr).toBe(0);
    expect(await statusOf(r, "c1")).toBe("done");
  }, 120_000);

  it("INT-38: a declared check's failure at another head is no evidence: `accept` is not refused for it", async () => {
    const r = g6Repo("sek-int38-");
    await inReview(r, "c1", { files: { "src/b.ts": "export const b = 2;\n" } });
    await withExternalResult(r, "c1", { name: "ci/build", passed: false, headSha: "a".repeat(40) });
    write(r.repo, ".sekhemet/config.toml", '[review]\nblocking_checks = ["ci/build"]\n');
    const accepted = await cliAsync(r, ["accept", "c1"]);
    expect(accepted.status, accepted.stdout + accepted.stderr).toBe(0);
    expect(await statusOf(r, "c1")).toBe("done");
  }, 120_000);
});
