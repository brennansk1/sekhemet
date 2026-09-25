import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initLocalKernel } from "../src/index.js";
import {
  latestLedgerEvidence,
  ledgerEvidenceSummary,
  recordLedgerRun,
} from "../src/ledger_evidence.js";

// kernel.md rules 27, 32; K-S7-7, K-S7-8: the Review entry condition reads
// the evidence the ledger records, never a `latest-<card>.json` pointer, and
// none recorded before a rewind. Real SQLite files (DoD §2A).

describe("Review reads its evidence from the ledger", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function inVerify(passed: boolean) {
    const repo = mkdtempSync(join(tmpdir(), "ledger-ev-"));
    dirs.push(repo);
    const k = initLocalKernel(repo);
    await k.cardStore.createCard({ id: "c", tier: "task", title: "C", scopeFiles: ["a.ts"] });
    await k.boardService.transitionCard({
      cardId: "c",
      fromStatus: "ready",
      toStatus: "in_progress",
      actor: "executor",
    });
    const body = write(repo, "ev_1", passed);
    await recordLedgerRun(k.cardStore, {
      cardId: "c",
      modelId: "m",
      passed,
      stopReason: passed ? "gate_passed" : "repair_exhausted",
      evidenceId: "ev_1",
      path: join(".sekhemet", "evidence", "ev_1.json"),
      body,
    });
    await k.boardService.transitionCard({
      cardId: "c",
      fromStatus: "in_progress",
      toStatus: "verify",
      actor: "executor",
    });
    return { repo, ...k };
  }

  function write(repo: string, id: string, passed: boolean, latest = true): string {
    const dir = join(repo, ".sekhemet", "evidence");
    mkdirSync(dir, { recursive: true });
    const body = `${JSON.stringify({
      id,
      cardId: "c",
      passed,
      rungResults: [{ gate: "test", layer: "unit", passed }],
    })}\n`;
    writeFileSync(join(dir, `${id}.json`), body);
    if (latest) writeFileSync(join(dir, "latest-c.json"), body);
    return body;
  }

  const toReview = (k: Awaited<ReturnType<typeof inVerify>>) =>
    k.boardService.transitionCard({
      cardId: "c",
      fromStatus: "verify",
      toStatus: "review",
      actor: "executor",
    });

  it("K-S7-7: deleting latest-<card>.json does not change the verdict", async () => {
    const k = await inVerify(true);
    unlinkSync(join(k.repo, ".sekhemet", "evidence", "latest-c.json"));
    await toReview(k);
    expect((await k.cardStore.getCard("c"))?.status).toBe("review");
    k.db.close();
  });

  it("K-S7-7: a passing latest-<card>.json the ledger does not record admits nothing", async () => {
    const k = await inVerify(false);
    // A pointer file claiming a pass, with no ledger record behind it.
    write(k.repo, "ev_forged", true);
    await expect(toReview(k)).rejects.toMatchObject({ code: "entry_condition" });
    // Nor does a recorded bundle whose file was changed after it was recorded.
    write(k.repo, "ev_1", true, false);
    await expect(toReview(k)).rejects.toMatchObject({ code: "entry_condition" });
    expect((await k.cardStore.getCard("c"))?.status).toBe("verify");
    k.db.close();
  });

  it("K-S7-8: a rewind invalidates earlier passing evidence until new evidence passes", async () => {
    const k = await inVerify(true);
    await k.cardStore.recordEvent({
      type: "card/rewound",
      cardId: "c",
      actor: "human",
      payload: { id: "c", step: 2, gitRef: "abc" },
    });
    await expect(toReview(k)).rejects.toMatchObject({
      code: "entry_condition",
      message: expect.stringMatching(/no evidence bundle/),
    });
    const body = write(k.repo, "ev_2", true);
    await recordLedgerRun(k.cardStore, {
      cardId: "c",
      modelId: "m",
      passed: true,
      stopReason: "gate_passed",
      evidenceId: "ev_2",
      path: join(".sekhemet", "evidence", "ev_2.json"),
      body,
    });
    await toReview(k);
    expect((await k.cardStore.getCard("c"))?.status).toBe("review");
    k.db.close();
  });

  it("K-N8-4: an external result is advisory unless its check is declared blocking, and never counts at another head", async () => {
    const k = await inVerify(true);
    const record = await latestLedgerEvidence(k.cardStore, "c");
    if (!record) throw new Error("no evidence");
    const external = async (checkName: string, passed: boolean, headSha: string) =>
      k.cardStore.runs.recordGateResult({
        attemptId: record.attemptId,
        cardId: "c",
        gate: checkName,
        layer: "ci",
        passed,
        exitCode: passed ? 0 : 1,
        durationMs: 1,
        failures: [],
        source: "external",
        externalRef: { system: "github", checkName, runUrl: "https://ci/run/1", headSha },
      });
    await external("ci/lint", false, "head1");
    await external("ci/build", false, "old0");
    const summary = (blockingChecks: string[]) =>
      ledgerEvidenceSummary(k.cardStore, k.repo, "c", {
        blockingChecks,
        branchHead: () => "head1",
      });
    // Not declared blocking: advisory, the verdict stands.
    expect(await summary([])).toMatchObject({ passed: true, gatesRun: 1 });
    // Declared blocking and at the card's head: it counts, and fails the evidence.
    expect(await summary(["ci/lint"])).toMatchObject({ passed: false, gatesRun: 2 });
    // At another head: not counted at all, even when declared blocking.
    expect(await summary(["ci/build"])).toMatchObject({ passed: true, gatesRun: 1 });
    // An unknown branch head counts no external result.
    expect(
      await ledgerEvidenceSummary(k.cardStore, k.repo, "c", { blockingChecks: ["ci/lint"] }),
    ).toMatchObject({ passed: true, gatesRun: 1 });
    k.db.close();
  });
});
