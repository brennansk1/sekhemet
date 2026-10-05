import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CardStore } from "@sekhemet/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { openLocalLedger } from "../../src/ledger_cmds.js";
import { BIN, sandboxDirs, scriptedWorkerProject } from "../cli_fixture.js";
import { cleanUp } from "./fault_fixture.js";

// C.6 fault 5: a corrupt configuration file. The built binary runs an issue
// to a stop with a scripted Worker; the project's config.toml is then cut
// mid-line, as a crash during a save or a bad edit leaves it, and the issue
// is run again (surface item 21, SUR-92).

afterEach(cleanUp);

function run(where: { cwd: string }, vars: Record<string, string>, preload: string, mode: string) {
  return spawnSync(
    process.execPath,
    ["--import", preload, BIN, "run", "c1", "--worker", "scripted-worker:latest"],
    {
      cwd: where.cwd,
      encoding: "utf8",
      timeout: 90_000,
      // The preload answers the Worker's address itself; the real Ollama is never reached.
      env: { ...vars, SCRIPTED_WORKER_MODE: mode },
    },
  );
}

describe("C.6: a corrupt configuration file", () => {
  it("refuses to run with the file, line and column and records nothing; once fixed, the issue continues from its recorded stop", async () => {
    const where = sandboxDirs();
    const env = await scriptedWorkerProject(where);
    const configPath = join(where.cwd, ".sekhemet", "config.toml");
    writeFileSync(
      configPath,
      '[review]\nreview_minutes_per_day = 45\n\n[network]\nmode = "offline"\n',
    );
    // A first run that stops without passing: its stop is recorded.
    const first = run(where, env.vars, env.preload, "stall");
    expect(first.status, first.stderr).toBe(1);
    const read = () => {
      const { db, log } = openLocalLedger(where.cwd);
      const store = new CardStore(db, log);
      const out = {
        valid: store.verifyLedger().valid,
        seq: log.lastSeq(),
        attempts: store.runs.listAttempts("c1"),
        card: store.getCard("c1"),
      };
      return { out, close: () => db.close() };
    };
    const before = read();
    const stopped = await before.out.card;
    expect(before.out.valid).toBe(true);
    expect(stopped?.stopReason).toBeTruthy();
    expect(before.out.attempts.at(-1)?.status).not.toBe("running");
    before.close();

    // The file is cut mid-line.
    const whole = readFileSync(configPath, "utf8");
    writeFileSync(configPath, whole.slice(0, whole.indexOf('"offline"') + 4));
    const refused = run(where, env.vars, env.preload, "finish");
    expect(refused.status).toBe(2);
    expect(refused.stderr).toMatch(
      new RegExp(`${configPath.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}:5:\\d+: `),
    );
    const during = read();
    expect(during.out.valid).toBe(true);
    // Nothing was recorded, and the issue keeps its recorded stop.
    expect(during.out.seq).toBe(before.out.seq);
    expect((await during.out.card)?.stopReason).toBe(stopped?.stopReason);
    during.close();

    // Fixed: the issue runs again and continues to Review.
    writeFileSync(configPath, whole);
    const resumed = run(where, env.vars, env.preload, "finish");
    expect(resumed.status, `${resumed.stdout}\n${resumed.stderr}`).toBe(0);
    const after = read();
    expect(after.out.valid).toBe(true);
    expect((await after.out.card)?.status).toBe("review");
    after.close();
  }, 240_000);
});
