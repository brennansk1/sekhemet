import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { MockInferenceAdapter } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import { executeCard } from "../../src/execute.js";
import { sweepCrashedAttempts } from "../../src/supervisor.js";
import {
  DIST,
  cleanUp,
  context,
  expectRecordedStop,
  finish,
  openLedger,
  projectRepo,
  readyCard,
  tempDir,
  track,
  waitFor,
} from "./fault_fixture.js";

// C.6 fault 2: `kill -9` of the daemon mid-transaction. The harness process
// running an issue is a real child process using the built harness and
// kernel; on the Worker's second step it is inside one of the ledger's
// multi-event transactions (`appendAllNow`, K-S7-3), with the first event
// inserted and the second not, when it is killed with SIGKILL.

afterEach(cleanUp);

const PACKAGES = resolve(DIST, "../../../packages");

describe("C.6: kill -9 of the daemon mid-transaction", () => {
  it("loses no committed event and writes no half transaction; the start-up sweep records crashed and resume continues from the checkpoint", async () => {
    const repo = projectRepo(tempDir("sek-fault-daemon-"));
    const setup = openLedger(repo);
    const card = await readyCard(setup, "card_daemon_kill");
    const eventsBefore = setup.log.lastSeq();
    setup.db.close();
    const marker = join(repo, "in-transaction");
    const script = join(repo, "daemon.mjs");
    writeFileSync(
      script,
      `import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { executeCard } from ${JSON.stringify(join(DIST, "execute.js"))};
import { CardStore, EventLog, initSchema } from ${JSON.stringify(join(PACKAGES, "kernel/dist/index.js"))};
import { BoardServiceImpl } from ${JSON.stringify(join(PACKAGES, "board/dist/index.js"))};
const repo = ${JSON.stringify(repo)};
const db = new DatabaseSync(repo + "/.sekhemet/events.db");
initSchema(db);
const log = new EventLog(db);
const cardStore = new CardStore(db, log);
const boardService = new BoardServiceImpl(cardStore);
let n = 0;
const adapter = {
  modelId: "scripted",
  supportedArms: ["arm_a_flat"],
  generate: async () => {
    n++;
    if (n === 2) {
      log.appendAllNow([
        { params: { type: "fault/group", actor: "harness", payload: { n: 1 }, cardId: "card_daemon_kill" },
          project: () => { writeFileSync(${JSON.stringify(marker)}, "in"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); } },
        { params: { type: "fault/group", actor: "harness", payload: { n: 2 }, cardId: "card_daemon_kill" } },
      ]);
    }
    return { text: "", toolCalls: [{ id: "w" + n, name: "write_file", arguments: { path: "src/a.ts", content: "export const a = " + n + ";\\n" } }], usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 } };
  },
};
const card = await cardStore.getCard("card_daemon_kill");
await executeCard({ repoPath: repo, workspaceFolder: repo, restrictedMode: false, cardStore, boardService, log: () => {}, headroomCheck: false, freeSpaceFloorBytes: 1 }, card, adapter);
`,
    );
    const daemon = track(
      spawn(process.execPath, [script], { stdio: ["ignore", "ignore", "inherit"] }),
    );
    await waitFor(() => existsSync(marker), 60_000, "the daemon inside its transaction");
    daemon.kill("SIGKILL");
    await new Promise((r) => daemon.once("exit", r));
    expect(daemon.signalCode).toBe("SIGKILL");

    // The next start: the ledger verifies, every committed event is there,
    // and nothing of the transaction the kill cut is.
    const l = openLedger(repo);
    expect(l.cardStore.verifyLedger().valid).toBe(true);
    expect(l.log.lastSeq()).toBeGreaterThan(eventsBefore);
    expect(
      l.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'fault/group'").get(),
    ).toEqual({ n: 0 });
    expect((await l.cardStore.getCard(card.id))?.status).toBe("in_progress");
    expect((await l.cardStore.getCheckpoints(card.id)).at(-1)?.step).toBe(1);
    // The start-up sweep finishes the attempt the kill left running.
    const swept = await sweepCrashedAttempts(repo, l.cardStore, l.boardService, {
      workspaceFolder: repo,
      freeSpaceFloorBytes: 1,
    });
    expect(swept).toEqual([expect.objectContaining({ cardId: card.id, stopReason: "crashed" })]);
    await expectRecordedStop(l, card.id, "crashed");
    expect((await l.cardStore.getCard(card.id))?.status).toBe("ready");
    // Resume continues from the last checkpoint.
    const resumed = await executeCard(
      context(repo, l),
      (await l.cardStore.getCard(card.id)) as never,
      new MockInferenceAdapter("scripted", [finish()]),
    );
    expect(resumed.resumedFrom?.step).toBe(1);
    expect(resumed.passed).toBe(true);
    expect(l.cardStore.verifyLedger().valid).toBe(true);
    l.db.close();
  }, 90_000);
});
