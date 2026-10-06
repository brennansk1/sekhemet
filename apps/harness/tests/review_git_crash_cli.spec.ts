import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { BIN, type G6Repo, eventsOf, g6Repo, inReview, statusOf } from "./support/g6_review.js";

/**
 * review-git NEW-review-git-8 (RG-N8-2) at the door (C2d, FINDINGS_C1
 * TST-01): a real `sekhemet accept` process is killed between its merge and
 * its record, then the next start — `sekhemet serve`, the dashboard most
 * Accepts are made on — sweeps the ledger against the real repository before
 * it serves. `accept_crash.spec.ts` proves the sweep on the functions.
 *
 * The binary under test is `apps/harness/dist/index.js`, spawned through
 * `support/g6_review.ts` (`BIN`).
 */

const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill("SIGKILL");
});

/**
 * Spawn `sekhemet accept <id>`, hold the ledger's write lock the moment its
 * `card/accept_started` is committed, wait for the integration branch to move,
 * and kill the process with SIGKILL: its merge landed, its record did not.
 */
async function killAcceptAfterMerge(
  r: G6Repo,
  id: string,
): Promise<{ before: string; merged: string }> {
  const before = r.git("rev-parse", "main");
  const watcher = new DatabaseSync(join(r.repo, ".sekhemet", "events.db"));
  watcher.exec("PRAGMA busy_timeout = 5000");
  const child = spawn(process.execPath, [BIN, "accept", id], {
    cwd: r.repo,
    env: r.env(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let out = "";
  child.stdout?.on("data", (d) => {
    out += String(d);
  });
  child.stderr?.on("data", (d) => {
    out += String(d);
  });
  let locked = false;
  const started = Date.now();
  while (Date.now() - started < 30_000 && child.exitCode === null) {
    const row = watcher
      .prepare("SELECT seq FROM events WHERE type = 'card/accept_started' AND card_id = ?")
      .get(id);
    if (row) {
      watcher.exec("BEGIN IMMEDIATE");
      locked = true;
      break;
    }
    await new Promise((ok) => setTimeout(ok, 1));
  }
  expect(locked, out).toBe(true);
  const until = Date.now() + 10_000;
  while (r.git("rev-parse", "main") === before && Date.now() < until)
    await new Promise((ok) => setTimeout(ok, 5));
  child.kill("SIGKILL");
  await new Promise((ok) => child.once("exit", ok));
  watcher.exec("ROLLBACK");
  watcher.close();
  return { before, merged: r.git("rev-parse", "main") };
}

/** `sekhemet serve` on a free port; resolves with its address once it serves. */
async function serve(r: G6Repo): Promise<{ address: string; child: ChildProcess }> {
  const child = spawn(process.execPath, [BIN, "serve", "--port", "0"], {
    cwd: r.repo,
    env: r.env(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let out = "";
  child.stderr?.on("data", (d) => {
    out += String(d);
  });
  const address = await new Promise<string>((ok, bad) => {
    const timer = setTimeout(() => bad(new Error(`no address: ${out}`)), 30_000);
    child.stdout?.on("data", (d) => {
      out += String(d);
      const m = /running at:\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        ok(m[1] as string);
      }
    });
    child.once("exit", (code) => bad(new Error(`serve exited ${code}: ${out}`)));
  });
  return { address, child };
}

const stop = async (child: ChildProcess) => {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((ok) => child.once("exit", ok)),
    new Promise((ok) => setTimeout(ok, 5000)),
  ]);
};

describe("RG-N8-2: the start-up sweep after a killed `sekhemet accept`", () => {
  it("RG-N8-2: the squash is on main, the process was killed before card/accepted; `sekhemet serve` records Done and card/accepted { reconciled: true } with the started record's principal", async () => {
    const r = g6Repo();
    await inReview(r, "c1", { files: { "src/b.ts": "export const b = 2;\n" } });
    const { before, merged } = await killAcceptAfterMerge(r, "c1");
    expect(merged).not.toBe(before);
    expect(r.git("rev-parse", "main^")).toBe(before);
    const [started] = await eventsOf(r, "c1", ["card/accept_started"]);
    expect(await eventsOf(r, "c1", ["card/accepted", "card/accept_failed"])).toEqual([]);
    expect(await statusOf(r, "c1")).toBe("review");

    const { address, child } = await serve(r);
    try {
      expect((await fetch(`${address}/api/board`)).status).toBe(200);
    } finally {
      await stop(child);
    }
    expect(await statusOf(r, "c1")).toBe("done");
    const accepted = await eventsOf(r, "c1", ["card/accepted"]);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.payload).toMatchObject({
      sha: merged,
      reconciled: true,
      principal: started?.payload.principal,
    });
    // The move to Done and card/accepted were written together, one after the other.
    const done = (await eventsOf(r, "c1", ["card/status_changed"])).find(
      (e) => e.payload.toStatus === "done",
    );
    expect(accepted[0]?.seq).toBe((done?.seq ?? 0) + 1);
    expect(r.git("rev-parse", "main")).toBe(merged);
    expect(await r.ledger(({ store }) => store.verifyLedger().valid)).toBe(true);
  }, 90_000);

  it("RG-N8-2: an accept_started whose squash is not on the integration branch is recorded as accept_failed by `sekhemet serve`, and the card stays In review", async () => {
    const r = g6Repo();
    await inReview(r, "c2", { files: { "src/b.ts": "export const b = 2;\n" } });
    const { before } = await killAcceptAfterMerge(r, "c2");
    // The merge is gone from the integration branch (a reset, a lost ref).
    r.git("update-ref", "refs/heads/main", before);
    const { address, child } = await serve(r);
    try {
      expect((await fetch(`${address}/api/board`)).status).toBe(200);
    } finally {
      await stop(child);
    }
    expect(await statusOf(r, "c2")).toBe("review");
    expect(await eventsOf(r, "c2", ["card/accepted"])).toEqual([]);
    const failed = await eventsOf(r, "c2", ["card/accept_failed"]);
    expect(failed.map((e) => e.payload)).toEqual([
      expect.objectContaining({ reason: "merge_missing", integration: "main" }),
    ]);
    expect(r.git("rev-parse", "main")).toBe(before);
  }, 90_000);
});
