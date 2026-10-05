import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, truncateSync, writeFileSync } from "node:fs";
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

// C.6 fault 10: a WAL truncated at a random frame, then the start-up sweep.
// A real runner process works an issue on the real kernel and is killed with
// SIGKILL before any checkpoint (the power cut comes first); its write-ahead
// log is then cut at a random point inside a random frame, as a torn write
// leaves it. The seed is printed with any failure, and `FAULT_SEED` replays
// one cut.

afterEach(cleanUp);

const PACKAGES = resolve(DIST, "../../../packages");

/** A small seeded generator (mulberry32), so a cut can be replayed. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function runOnce(seed: number): Promise<void> {
  const rand = random(seed);
  const repo = projectRepo(tempDir("sek-fault-wal-"));
  const setup = openLedger(repo);
  const card = await readyCard(setup, "card_wal");
  // Closed: the setup is checkpointed into the database file.
  setup.db.close();
  const marker = join(repo, "third-step");
  const script = join(repo, "runner.mjs");
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
// The power cut comes before any checkpoint: everything this run writes is in the WAL.
db.exec("PRAGMA wal_autocheckpoint = 0");
const log = new EventLog(db);
const cardStore = new CardStore(db, log);
const boardService = new BoardServiceImpl(cardStore);
let n = 0;
const adapter = {
  modelId: "scripted",
  supportedArms: ["arm_a_flat"],
  generate: async () => {
    n++;
    if (n === 3) { setInterval(() => {}, 1000); writeFileSync(${JSON.stringify(marker)}, "3"); await new Promise(() => {}); }
    return { text: "", toolCalls: [{ id: "w" + n, name: "write_file", arguments: { path: "src/a.ts", content: "export const a = " + n + ";\\n" } }], usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 } };
  },
};
await executeCard({ repoPath: repo, workspaceFolder: repo, restrictedMode: false, cardStore, boardService, log: () => {}, headroomCheck: false, freeSpaceFloorBytes: 1 }, await cardStore.getCard("card_wal"), adapter);
`,
  );
  const runner = track(
    spawn(process.execPath, [script], { stdio: ["ignore", "ignore", "inherit"] }),
  );
  await waitFor(() => existsSync(marker), 60_000, "the runner's third step");
  runner.kill("SIGKILL");
  await new Promise((r) => runner.once("exit", r));

  // The cut: a random point inside a random frame of the WAL.
  const wal = join(repo, ".sekhemet", "events.db-wal");
  const header = readFileSync(wal).subarray(0, 32);
  const pageSize = header.readUInt32BE(8);
  const frameSize = 24 + pageSize;
  const frames = Math.floor((statSync(wal).size - 32) / frameSize);
  expect(frames).toBeGreaterThan(1);
  const frame = Math.floor(rand() * frames);
  const cut = 32 + frame * frameSize + Math.floor(rand() * frameSize);
  truncateSync(wal, cut);

  // The next start: the chain verifies to its last intact event; no issue is lost.
  const l = openLedger(repo);
  expect(l.cardStore.verifyLedger().valid).toBe(true);
  expect(await l.cardStore.getCard(card.id)).toBeTruthy();
  const swept = await sweepCrashedAttempts(repo, l.cardStore, l.boardService, {
    workspaceFolder: repo,
    freeSpaceFloorBytes: 1,
  });
  const after = await l.cardStore.getCard(card.id);
  // Never left In Progress: the sweep finished a running attempt as crashed;
  // a cut before the attempt began leaves the issue as it was, in Ready.
  expect(after?.status).toBe("ready");
  // A cut after the run's claim of the issue (Ready to Planning) and before its
  // attempt began is swept too, with the stop on the issue alone.
  if (swept[0]?.attemptId) await expectRecordedStop(l, card.id, "crashed");
  else if (swept.length > 0) expect(after?.stopReason).toBe("crashed");
  else
    expect(l.cardStore.runs.listAttempts(card.id).filter((a) => a.status === "running")).toEqual(
      [],
    );
  // Resume continues, from the last checkpoint the ledger kept.
  const kept = (await l.cardStore.getCheckpoints(card.id)).at(-1)?.step;
  const resumed = await executeCard(
    context(repo, l),
    after as never,
    new MockInferenceAdapter("scripted", [finish()]),
  );
  expect(resumed.passed).toBe(true);
  if (kept !== undefined) expect(resumed.resumedFrom?.step).toBe(kept);
  expect(l.cardStore.verifyLedger().valid).toBe(true);
  l.db.close();
}

describe("C.6: a WAL truncated at a random frame, then the sweep", () => {
  it("verifies to the last intact event, loses no issue, never leaves one In Progress, and resume continues", async () => {
    const seed = Number(process.env.FAULT_SEED ?? Date.now() % 1_000_000);
    try {
      await runOnce(seed);
    } catch (err) {
      throw new Error(`FAULT_SEED=${seed}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, 120_000);
});
