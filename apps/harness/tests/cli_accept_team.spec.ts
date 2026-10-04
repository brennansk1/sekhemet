import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CardStore } from "@sekhemet/kernel";
import { describe, expect, it } from "vitest";
import { openLocalLedger } from "../src/ledger_cmds.js";
import { BIN, cardInReview, sandboxDirs } from "./cli_fixture.js";

/**
 * FINDINGS_C1 SEC-03 (SPINE: the human is the rate limiter; review-git
 * RG-N5-1, RG-N5-8; teams item 7, INT-22): the project's Accept rule holds on
 * the command line as it does on the dashboard. `sekhemet accept` is spawned
 * as the built binary on a Team install whose project names two Accept
 * holders; the person at the terminal accepts only when the rule names them
 * and they did not delegate or build the issue.
 */

const ALICE = "p_alice";

/** The binary on a Team install: `[team] mode = "team"` in the user configuration. */
function teamCli(where: { cwd: string; home: string }, userConfig: string, args: string[]) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: where.cwd,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: where.home,
      SEKHEMET_CONFIG_DIR: join(where.home, ".sekhemet"),
      SEKHEMET_USER_CONFIG: userConfig,
      SEKHEMET_MODEL_LOADS: "off",
      BROWSER: "false",
    },
  });
}

/**
 * An issue In review in a project whose Accept rule names `rule`; Alice is a
 * Member, and so is the person at the terminal (`me`). `delegator` handed the
 * issue to the Agent last.
 */
async function teamProject(rule: (me: string) => string[], delegator: (me: string) => string) {
  const where = sandboxDirs();
  const me = await cardInReview(where, "c1");
  const { db, log } = openLocalLedger(where.cwd);
  try {
    const store = new CardStore(db, log);
    const project = await store.ensureProject({ rootPath: where.cwd, name: "Chronicle" });
    for (const p of [ALICE, me])
      log.appendNow({
        actor: "system",
        type: "member/joined",
        principal: p,
        payload: { principal: p, level: "member", via: "invite", pending: false },
      });
    log.appendNow({
      actor: "human",
      type: "project/settings_changed",
      principal: me,
      payload: { project: project.id, accept_rule: rule(me) },
    });
    const by = delegator(me);
    if (by !== me) {
      await store.delegateCard("c1", null, by);
      await store.delegateCard("c1", { kind: "worker" }, by);
    }
  } finally {
    db.close();
  }
  const userConfig = join(where.home, "team-config.toml");
  writeFileSync(userConfig, '[team]\nmode = "team"\n');
  return { where, me, userConfig };
}

const statusOf = async (cwd: string) => {
  const { db, log } = openLocalLedger(cwd);
  try {
    return (await new CardStore(db, log).getCard("c1"))?.status;
  } finally {
    db.close();
  }
};

describe("SEC-03: the Team Accept rule from the command line", () => {
  it("refuses a person the project's Accept rule does not name, naming who may, and leaves the issue In review", async () => {
    const { where, userConfig } = await teamProject(
      () => [ALICE],
      () => ALICE,
    );
    const r = teamCli(where, userConfig, ["accept", "c1"]);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stderr).toContain(ALICE);
    expect(await statusOf(where.cwd)).toBe("review");
  });

  it("refuses the person who handed the issue to the Agent, on a two-holder project", async () => {
    const { where, userConfig } = await teamProject(
      (me) => [ALICE, me],
      (me) => me,
    );
    const r = teamCli(where, userConfig, ["accept", "c1", "--json"]);
    expect(r.status).toBe(1);
    const v = JSON.parse(r.stdout.trim()) as { refusal: string; accepted: boolean };
    expect(v).toMatchObject({ accepted: false, refusal: "not_independent" });
    expect(await statusOf(where.cwd)).toBe("review");
  });

  it("accepts for a holder who neither built nor delegated it", async () => {
    const { where, userConfig, me } = await teamProject(
      (m) => [ALICE, m],
      () => ALICE,
    );
    const r = teamCli(where, userConfig, ["accept", "c1"]);
    expect(r.status, r.stderr).toBe(0);
    expect(await statusOf(where.cwd)).toBe("done");
    const { db, log } = openLocalLedger(where.cwd);
    try {
      const [accepted] = await new CardStore(db, log).cardEvents("c1", ["card/accepted"]);
      expect(accepted?.payload).toMatchObject({ principal: me, independent: true });
    } finally {
      db.close();
    }
  });

  it("refuses `revert` for a person the project's Accept rule no longer names, and leaves the issue Done", async () => {
    const { where, userConfig, me } = await teamProject(
      (m) => [ALICE, m],
      () => ALICE,
    );
    expect(teamCli(where, userConfig, ["accept", "c1"]).status).toBe(0);
    expect(await statusOf(where.cwd)).toBe("done");
    // The rule changes: only Alice may accept, and so only Alice may revert (surface rule 16).
    const { db, log } = openLocalLedger(where.cwd);
    try {
      const project = (await new CardStore(db, log).listProjects())[0];
      log.appendNow({
        actor: "human",
        type: "project/settings_changed",
        principal: me,
        payload: { project: project?.id, accept_rule: [ALICE] },
      });
    } finally {
      db.close();
    }
    const r = teamCli(where, userConfig, ["revert", "c1", "a regression"]);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stderr).toContain(ALICE);
    expect(await statusOf(where.cwd)).toBe("done");
  });

  it("lets a person the project's Accept rule names `revert` an accepted issue, back to Ready", async () => {
    const { where, userConfig } = await teamProject(
      (m) => [ALICE, m],
      () => ALICE,
    );
    expect(teamCli(where, userConfig, ["accept", "c1"]).status).toBe(0);
    const r = teamCli(where, userConfig, ["revert", "c1", "a regression"]);
    expect(r.status, r.stderr).toBe(0);
    expect(await statusOf(where.cwd)).toBe("ready");
  });
});
