import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { CardStore } from "@sekhemet/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { openLocalLedger } from "../../src/ledger_cmds.js";
import { BIN, sandboxDirs, scriptedWorkerProject } from "../cli_fixture.js";
import { cleanUp, track, waitFor } from "./fault_fixture.js";

// C.6 fault 8: two servers on one project. The built binary's `serve` is
// started twice in the same project, and two `run`s of the same issue are
// started at once, each a real process on the one ledger.

afterEach(cleanUp);

async function freePort(): Promise<number> {
  return new Promise((ok) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => ok(p));
    });
  });
}

const answers = async (port: number) =>
  fetch(`http://127.0.0.1:${port}/api/workspaces/id`)
    .then((r) => r.ok)
    .catch(() => false);

describe("C.6: two servers on one project", () => {
  it("the second serve names the first and starts nothing; of two runs one holds the lease; the issue ends in its recorded stop and the ledger verifies", async () => {
    const where = sandboxDirs();
    const env = await scriptedWorkerProject(where);
    const [portA, portB] = [await freePort(), await freePort()];
    let outA = "";
    const serveA = track(
      spawn(process.execPath, [BIN, "serve", "--port", String(portA)], {
        cwd: where.cwd,
        env: { ...env.vars, SEKHEMET_MODEL_LOADS: "off" },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    serveA.stdout?.on("data", (d) => {
      outA += String(d);
    });
    serveA.stderr?.on("data", (d) => {
      outA += String(d);
    });
    let up = false;
    await waitFor(
      () => {
        void answers(portA).then((ok) => {
          up = ok;
        });
        return up;
      },
      60_000,
      `the first server (${outA})`,
    );
    const second = spawnSync(process.execPath, [BIN, "serve", "--port", String(portB)], {
      cwd: where.cwd,
      encoding: "utf8",
      timeout: 30_000,
      env: { ...env.vars, SEKHEMET_MODEL_LOADS: "off" },
    });
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain(`already served at http://127.0.0.1:${portA}`);
    expect(await answers(portB)).toBe(false);

    // Two runs of the issue at once, both against the ledger the server holds open.
    const runOnce = () =>
      new Promise<{ status: number | null; out: string }>((ok) => {
        let out = "";
        const p = spawn(
          process.execPath,
          ["--import", env.preload, BIN, "run", "c1", "--worker", "scripted-worker:latest"],
          { cwd: where.cwd, env: { ...env.vars, SCRIPTED_WORKER_MODE: "finish" } },
        );
        p.stdout?.on("data", (d) => {
          out += String(d);
        });
        p.stderr?.on("data", (d) => {
          out += String(d);
        });
        p.on("exit", (status) => ok({ status, out }));
      });
    const [r1, r2] = await Promise.all([runOnce(), runOnce()]);
    const statuses = [r1.status, r2.status].sort();
    const refused = [r1, r2].find((r) => r.status !== 0);
    expect(statuses, `${r1.out}\n---\n${r2.out}`).toEqual([0, 1]);
    expect(refused?.out).toMatch(/Another runner holds the lease here \(pid \d+, run c1, since /);
    // The server is still up; the ledger verifies; the issue ran once and ended in its recorded stop.
    expect(await answers(portA)).toBe(true);
    const { db, log } = openLocalLedger(where.cwd);
    const store = new CardStore(db, log);
    expect(store.verifyLedger().valid).toBe(true);
    const attempts = store.runs.listAttempts("c1");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.stopReason).toBe("gate_passed");
    const card = await store.getCard("c1");
    expect([card?.status, card?.stopReason]).toEqual(["review", "gate_passed"]);
    db.close();
  }, 180_000);
});
